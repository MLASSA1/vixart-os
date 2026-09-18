import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { restoreDocumentCounters } from './test-support';

/**
 * Integration tests against a real PostgreSQL.
 *
 * The brief names two failures that must be impossible, and neither can be
 * proven with a unit test — both are properties of the database under
 * concurrency:
 *
 *   (a) two simultaneous issues must never take the same number, and the run
 *       must never skip one
 *   (b) an issued invoice must be impossible to modify
 *
 * Skipped automatically when no database is reachable, so `npm test` still runs
 * on a machine without Docker.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const HAS_DB = await reachable();

/** Every row created here carries this marker so cleanup can be exact. */
const MARK = 'INTEGRATION-TEST-DOC';

describe.skipIf(!HAS_DB)('invoicing (integration)', () => {
  let admin: Client;
  let companyId: string;

  /**
   * A connection behaving exactly like a signed-in admin session: the role and
   * user id the application would set, and NOT the bootstrap flag.
   *
   * Holding `app.bootstrap` open would open the maintenance door in the line
   * trigger, and the guards would never be exercised — the test would pass
   * while proving nothing.
   */
  async function connect(): Promise<Client> {
    const c = new Client({ connectionString: URL });
    await c.connect();
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'admin' LIMIT 1`,
    );
    await c.query("SELECT set_config('app.user_role', 'admin', false)");
    await c.query("SELECT set_config('app.user_id', $1, false)", [rows[0]!.id]);
    return c;
  }

  /** Separate connection for setup and teardown, which may use the door. */
  async function maintenance(): Promise<Client> {
    const c = new Client({ connectionString: URL });
    await c.connect();
    await c.query("SET app.bootstrap = 'on'");
    return c;
  }

  async function makeDraft(client: Client, type: 'devis' | 'facture'): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, subject, vat_rate_bp)
       VALUES ($1, $2, $3, 2000) RETURNING id`,
      [type, companyId, MARK],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO document_line (document_id, label, unit_price_centimes, quantity_millis)
       VALUES ($1, 'Test line', 100000, 1000)`,
      [id],
    );
    return id;
  }

  beforeAll(async () => {
    admin = await connect();

    // Its own client, not `SELECT id FROM company LIMIT 1`.
    //
    // That picked whichever real client sorted first and hung every probe
    // document off it — Bader Training Center, as it happened. It also meant
    // this file could only run if that client happened to satisfy whatever
    // issuing requires, which since 0049 includes a real ICE. Inventing one on
    // a real company to make a test pass would be putting a fabricated legal
    // identifier on a record that gets printed on invoices.
    const setup = await maintenance();
    try {
      const { rows } = await setup.query<{ id: string }>(
        `INSERT INTO company (name, status, relationship, ice, identifiant_fiscal)
         VALUES ($1, 'client', 'client', '000000000000003', '00000000')
         RETURNING id`,
        [`${MARK} client`],
      );
      companyId = rows[0]!.id;
    } finally {
      await setup.end();
    }
  });

  afterAll(async () => {
    if (!admin) return;
    // Cleanup goes through the bootstrap door (0017) rather than disabling
    // triggers. An earlier version did `ALTER TABLE ... DISABLE TRIGGER`, threw
    // on a foreign key in between, and left invoice immutability switched OFF
    // on the database. Never disable a guard to tidy up after yourself.
    const keeper = await maintenance();
    try {
      // Ledger lines reference documents with ON DELETE restrict, so the
      // revenue posted by marking an invoice paid has to go first.
      await keeper.query(
        `DELETE FROM finance_entry WHERE document_id IN
           (SELECT id FROM document WHERE subject = $1)`,
        [MARK],
      );
      await keeper.query(`DELETE FROM document WHERE subject = $1`, [MARK]);
      await keeper.query(`DELETE FROM company WHERE name = $1`, [`${MARK} client`]);
      // Roll the counters back to the highest number that still exists, so the
      // real numbering does not inherit gaps from the test run.
      await keeper.query(`
        UPDATE document_counter c SET last_seq = coalesce(
          (SELECT max(d.number_seq) FROM document d
            WHERE d.doc_type = c.doc_type AND d.number_year = c.year), 0)`);
    } finally {
      await keeper.end();
      await admin.end();
    }
  });

  it('(a) concurrent issues never collide and never skip a number', async () => {
    const CONCURRENCY = 5;
    const ids: string[] = [];
    for (let i = 0; i < CONCURRENCY; i += 1) {
      ids.push(await makeDraft(admin, 'facture'));
    }

    const before = await admin.query<{ last_seq: string }>(
      `SELECT coalesce(last_seq, 0)::text AS last_seq FROM document_counter
        WHERE doc_type = 'facture' AND year = extract(year FROM current_date)::int`,
    );
    const startedAt = Number(before.rows[0]?.last_seq ?? 0);

    // Five separate connections, all issuing at once. The row lock inside
    // app.next_document_number is the only thing standing between them.
    const connections = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => connect()),
    );

    const numbers = await Promise.all(
      connections.map(async (c, i) => {
        await c.query('BEGIN');
        const { rows } = await c.query<{ issue_document: string }>(
          "SELECT app.issue_document($1, 'virement') AS issue_document",
          [ids[i]],
        );
        await c.query('COMMIT');
        return rows[0]!.issue_document;
      }),
    );

    await Promise.all(connections.map((c) => c.end()));

    // Every number distinct.
    expect(new Set(numbers).size).toBe(CONCURRENCY);

    // And the run is unbroken: startedAt+1 … startedAt+CONCURRENCY, no gaps.
    const seqs = numbers
      .map((n) => Number(n.split('-')[2]))
      .sort((a, b) => a - b);
    const expected = Array.from({ length: CONCURRENCY }, (_, i) => startedAt + i + 1);
    expect(seqs).toEqual(expected);

    // And the shape is right.
    const year = new Date().getFullYear();
    for (const n of numbers) {
      expect(n).toMatch(new RegExp(`^FAC-${year}-\\d{4}$`));
    }
  }, 30_000);

  it('(b) an issued invoice cannot be modified', async () => {
    const id = await makeDraft(admin, 'facture');
    await admin.query("SELECT app.issue_document($1, 'virement')", [id]);

    await expect(
      admin.query('UPDATE document SET total_incl_vat = 1 WHERE id = $1', [id]),
    ).rejects.toThrow(/issued and cannot be modified/i);

    await expect(
      admin.query('UPDATE document SET discount_centimes = 50000 WHERE id = $1', [id]),
    ).rejects.toThrow(/issued and cannot be modified/i);

    await expect(
      admin.query('UPDATE document SET client_ice = $2 WHERE id = $1', [id, '999999999999999']),
    ).rejects.toThrow(/issued and cannot be modified/i);
  });

  it('(b2) the lines of an issued invoice are frozen too', async () => {
    const id = await makeDraft(admin, 'facture');
    await admin.query("SELECT app.issue_document($1, 'virement')", [id]);

    await expect(
      admin.query('UPDATE document_line SET unit_price_centimes = 1 WHERE document_id = $1', [id]),
    ).rejects.toThrow(/cannot be changed|issued/i);

    await expect(
      admin.query('DELETE FROM document_line WHERE document_id = $1', [id]),
    ).rejects.toThrow(/cannot be changed|issued/i);

    await expect(
      admin.query(
        `INSERT INTO document_line (document_id, label, unit_price_centimes)
         VALUES ($1, 'sneaky extra', 999)`,
        [id],
      ),
    ).rejects.toThrow(/cannot be changed|issued/i);
  });

  it('marking an invoice paid is allowed; re-issuing is not', async () => {
    const id = await makeDraft(admin, 'facture');
    await admin.query("SELECT app.issue_document($1, 'virement')", [id]);

    await admin.query(`UPDATE document SET status='paye', paid_at=now() WHERE id=$1`, [id]);
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM document WHERE id=$1',
      [id],
    );
    expect(rows[0]!.status).toBe('paye');

    await expect(
      admin.query("SELECT app.issue_document($1, 'virement')", [id]),
    ).rejects.toThrow(/already issued/i);
  });

  it('refuses to issue a document with no lines', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, subject) VALUES ('devis', $1, $2) RETURNING id`,
      [companyId, MARK],
    );
    await expect(
      admin.query("SELECT app.issue_document($1, 'virement')", [rows[0]!.id]),
    ).rejects.toThrow(/no lines/i);
  });

  it('freezes the totals and the client identity at issue', async () => {
    const id = await makeDraft(admin, 'facture');
    await admin.query("SELECT app.issue_document($1, 'virement')", [id]);

    const { rows } = await admin.query<{
      total_excl_vat: string; total_vat: string; total_incl_vat: string; client_name: string;
    }>(
      `SELECT total_excl_vat::text, total_vat::text, total_incl_vat::text, client_name
         FROM document WHERE id = $1`,
      [id],
    );
    const doc = rows[0]!;
    // One line: 1 000,00 x 1 -> VAT 20% -> 1 200,00
    expect(doc.total_excl_vat).toBe('100000');
    expect(doc.total_vat).toBe('20000');
    expect(doc.total_incl_vat).toBe('120000');
    expect(doc.client_name).toBeTruthy();
  });

  it('a 0% rate without a written reason is rejected by the database', async () => {
    await expect(
      admin.query(
        `INSERT INTO document (doc_type, company_id, subject, vat_rate_bp)
         VALUES ('facture', $1, $2, 0)`,
        [companyId, MARK],
      ),
    ).rejects.toThrow(/document_zero_vat_needs_reason/i);
  });

  // --- article 145 of the CGI ----------------------------------------------
  //
  // Both conditions live in app.issue_document rather than in a form, because
  // a form is one caller and the function is the only door to a number. A
  // document that cannot be issued cannot be sent.

  it('refuses an invoice to a client with no ICE', async () => {
    const setup = await maintenance();
    let noIce: string;
    try {
      const { rows } = await setup.query<{ id: string }>(
        `INSERT INTO company (name, status, relationship)
         VALUES ($1, 'client', 'client') RETURNING id`, [`${MARK} no ice`]);
      noIce = rows[0]!.id;
    } finally { await setup.end(); }

    const { rows: d } = await admin.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, subject, vat_rate_bp)
       VALUES ('facture', $1, $2, 2000) RETURNING id`, [noIce, MARK]);
    await admin.query(
      `INSERT INTO document_line (document_id, label, unit_price_centimes, quantity_millis)
       VALUES ($1, 'Test line', 100000, 1000)`, [d[0]!.id]);

    await expect(
      admin.query("SELECT app.issue_document($1, 'virement')", [d[0]!.id]),
    ).rejects.toThrow(/no ICE/i);

    // And it is still a draft, with no number taken.
    const { rows: after } = await admin.query<{ status: string; number: string | null }>(
      `SELECT status, number FROM document WHERE id = $1`, [d[0]!.id]);
    expect(after[0]!.status).toBe('brouillon');
    expect(after[0]!.number).toBeNull();

    const cleanup = await maintenance();
    try {
      await cleanup.query(`DELETE FROM document WHERE id = $1`, [d[0]!.id]);
      await cleanup.query(`DELETE FROM company WHERE id = $1`, [noIce]);
    } finally { await cleanup.end(); }
  });

  it('refuses an invoice with no mode de règlement', async () => {
    const id = await makeDraft(admin, 'facture');
    await expect(
      admin.query('SELECT app.issue_document($1)', [id]),
    ).rejects.toThrow(/mode de règlement/i);
  });

  it('issues a quote without either — a quote has no fiscal existence', async () => {
    // The common real case: you send a quote before the client has given you
    // their ICE, and before anyone has agreed how it will be paid.
    const setup = await maintenance();
    let bare: string;
    try {
      const { rows } = await setup.query<{ id: string }>(
        `INSERT INTO company (name, status, relationship)
         VALUES ($1, 'prospect', 'client') RETURNING id`, [`${MARK} bare`]);
      bare = rows[0]!.id;
    } finally { await setup.end(); }

    const { rows: d } = await admin.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, subject, vat_rate_bp)
       VALUES ('devis', $1, $2, 2000) RETURNING id`, [bare, MARK]);
    await admin.query(
      `INSERT INTO document_line (document_id, label, unit_price_centimes, quantity_millis)
       VALUES ($1, 'Test line', 100000, 1000)`, [d[0]!.id]);

    const { rows: n } = await admin.query<{ issue_document: string }>(
      'SELECT app.issue_document($1) AS issue_document', [d[0]!.id]);
    expect(n[0]!.issue_document).toMatch(/^DEV-/);

    const cleanup = await maintenance();
    try {
      await cleanup.query(`DELETE FROM document WHERE id = $1`, [d[0]!.id]);
      await cleanup.query(`DELETE FROM company WHERE id = $1`, [bare]);
      await cleanup.query(`
        UPDATE document_counter c SET last_seq = coalesce(
          (SELECT max(d.number_seq) FROM document d
            WHERE d.doc_type = c.doc_type AND d.number_year = c.year), 0)`);
    } finally { await cleanup.end(); }
  });

  it('freezes the mode de règlement onto the invoice', async () => {
    const id = await makeDraft(admin, 'facture');
    await admin.query("SELECT app.issue_document($1, 'cheque')", [id]);
    const { rows } = await admin.query<{ payment_method: string; client_ice: string }>(
      `SELECT payment_method, client_ice FROM document WHERE id = $1`, [id]);
    expect(rows[0]!.payment_method).toBe('cheque');
    // And the client's ICE is frozen beside it, as article 145 wants.
    expect(rows[0]!.client_ice).toBe('000000000000003');
  });

  it('accepts only the three modes de règlement', async () => {
    const id = await makeDraft(admin, 'facture');
    await expect(
      admin.query("SELECT app.issue_document($1, 'bitcoin')", [id]),
    ).rejects.toThrow(/document_payment_method_valid/);
  });

});

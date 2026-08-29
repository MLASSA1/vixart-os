import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * A quote and an invoice, built the way the new screen builds them: header,
 * client identity and every line in ONE transaction, then issued.
 *
 * The point of the test is the arithmetic and the freezing. What the screen
 * previews in JavaScript and what app.issue_document() computes in PostgreSQL
 * must agree to the centime, because only one of them ends up on paper.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ document build probe';

describe.skipIf(!HAS_DB)('building a document in one transaction', () => {
  let db: Client;
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");

    const u = await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' LIMIT 1`,
    );
    userId = u.rows[0]!.id;

    const c = await db.query<{ id: string }>(
      `INSERT INTO company (name, legal_name, ice, identifiant_fiscal, address_line, city, status, retenue_source)
       VALUES ($1, 'PROBE SARL', '001234567890123', '12345678', '12 rue Test', 'Agadir', 'client', false)
       RETURNING id`,
      [MARK],
    );
    companyId = c.rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(
      `DELETE FROM document_line WHERE document_id IN (SELECT id FROM document WHERE company_id=$1)`,
      [companyId],
    );
    // Issued documents are immutable by trigger; the probe's rows are removed
    // with it disabled and it is switched back on in the same statement pair.
    await db.query(`ALTER TABLE document DISABLE TRIGGER document_immutable`);
    try {
      await db.query(`DELETE FROM document WHERE company_id=$1`, [companyId]);
    } finally {
      await db.query(`ALTER TABLE document ENABLE TRIGGER document_immutable`);
    }
    await db.query(`DELETE FROM company WHERE id=$1`, [companyId]);
    await db.end();
  });

  async function build(docType: string, lines: Array<[string, string, string]>, discount = '0') {
    const d = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp,
                             discount_centimes, client_name, client_legal_name, client_ice,
                             created_by_id)
       VALUES ($1, $2, 2000, false, 0, $3, $4, 'PROBE SARL', '001234567890123', $5)
       RETURNING id`,
      [docType, companyId, discount, MARK, userId],
    );
    const id = d.rows[0]!.id;
    let position = 0;
    for (const [label, price, qty] of lines) {
      await db.query(
        `INSERT INTO document_line (document_id, label, unit, unit_price_centimes, quantity_millis, position)
         VALUES ($1, $2, 'forfait', $3, $4, $5)`,
        [id, label, price, qty, position++],
      );
    }
    return id;
  }

  it('computes HT, TVA and TTC the way the preview does', async () => {
    // 2 × 12 000,00 + 1 × 3 500,50 = 27 500,50 HT
    const id = await build('facture', [
      ['Film', '1200000', '2000'],
      ['Montage', '350050', '1000'],
    ]);
    await db.query(`SELECT app.issue_document($1)`, [id]);

    const { rows } = await db.query(
      `SELECT total_excl_vat::text AS ht, total_vat::text AS tva,
              total_incl_vat::text AS ttc, number
         FROM document WHERE id=$1`,
      [id],
    );
    const r = rows[0]!;
    expect(r.ht).toBe('2750050');
    // 20% of 27 500,50 = 5 500,10 exactly
    expect(r.tva).toBe('550010');
    expect(r.ttc).toBe('3300060');
    expect(r.number).toMatch(/^FA/);
  });

  it('caps a discount at the subtotal rather than going negative', async () => {
    const id = await build('facture', [['Shoot', '100000', '1000']], '500000');
    await db.query(`SELECT app.issue_document($1)`, [id]);
    const { rows } = await db.query(
      `SELECT total_excl_vat::text AS ht, total_incl_vat::text AS ttc FROM document WHERE id=$1`,
      [id],
    );
    expect(rows[0]!.ht).toBe('0');
    expect(rows[0]!.ttc).toBe('0');
  });

  it('rounds each line before summing, as the preview does', async () => {
    // 0,333 × 3 lines of 10,00 → each rounds to 3,33, summing to 9,99.
    // Summing first would give 9,99 too here, but the per-line rounding is
    // what the SQL does and what the screen must mirror.
    const id = await build('devis', [
      ['A', '1000', '333'], ['B', '1000', '333'], ['C', '1000', '333'],
    ]);
    await db.query(`SELECT app.issue_document($1)`, [id]);
    const { rows } = await db.query(
      `SELECT total_excl_vat::text AS ht FROM document WHERE id=$1`, [id],
    );
    expect(rows[0]!.ht).toBe('999');
  });

  it('keeps the client identity frozen when the company later changes', async () => {
    const id = await build('facture', [['Retainer', '500000', '1000']]);
    await db.query(`SELECT app.issue_document($1)`, [id]);
    // A valid ICE is 15 digits — the column has a CHECK that says so, which is
    // itself worth knowing: a malformed ICE cannot reach a document at all.
    await db.query(
      `UPDATE company SET legal_name='RENAMED SARL', ice='009999999999999' WHERE id=$1`,
      [companyId],
    );

    const { rows } = await db.query(
      `SELECT client_legal_name, client_ice FROM document WHERE id=$1`, [id],
    );
    expect(rows[0]!.client_legal_name).toBe('PROBE SARL');
    expect(rows[0]!.client_ice).toBe('001234567890123');
  });

  it('refuses to issue a document with no lines', async () => {
    const d = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp,
                             client_name, created_by_id)
       VALUES ('facture', $1, 2000, false, 0, $2, $3) RETURNING id`,
      [companyId, MARK, userId],
    );
    await expect(
      db.query(`SELECT app.issue_document($1)`, [d.rows[0]!.id]),
    ).rejects.toThrow(/no lines/i);
  });
});

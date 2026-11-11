import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { restoreDocumentCounters } from './test-support';

/**
 * A payment is never deleted; the owner alone can reverse one (0083).
 *
 * Amin: "a record of the payment always stays in the data", and asked whether
 * one may ever be removed, "never removed — only my account has that access".
 *
 * Proven at the database, as the APPLICATION's own restricted role with a real
 * identity — not as the table owner, who bypasses every rule here and so
 * proves nothing about them.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;

async function reachable(url?: string): Promise<boolean> {
  if (!url) return false;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = (await reachable(URL)) && (await reachable(APP));
const MARK = 'ZZZ reversal probe';
const SECOND_ADMIN = 'zzz-reversal-second-admin@vixart.test';

describe.skipIf(!HAS_DB)('payment reversals (integration)', () => {
  let owner: Client;  // table owner, bootstrap: setup only
  let app: Client;    // vixart_app, as a person: every rule is tested here
  let companyId: string;
  let ownerId: string;
  let otherAdminId: string;

  async function as(id: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false), set_config('app.user_role',$2,false)`, [id, role]);
  }

  async function purge() {
    await owner.query(`DELETE FROM finance_entry WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    await owner.query(`ALTER TABLE document_payment DISABLE TRIGGER payment_delete_rules`);
    try {
      // Reversals first: they point at the payments they cancel.
      await owner.query(
        `DELETE FROM document_payment WHERE reverses_id IS NOT NULL AND document_id IN
           (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
      await owner.query(
        `DELETE FROM document_payment WHERE document_id IN
           (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
    } finally {
      await owner.query(`ALTER TABLE document_payment ENABLE TRIGGER payment_delete_rules`);
    }
    await owner.query(`DELETE FROM document_line WHERE document_id IN (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
    await owner.query(`ALTER TABLE document DISABLE TRIGGER document_immutable`);
    try {
      await owner.query(`DELETE FROM document WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    } finally {
      await owner.query(`ALTER TABLE document ENABLE TRIGGER document_immutable`);
    }
    await owner.query(`DELETE FROM company WHERE name=$1`, [MARK]);
    await owner.query(`DELETE FROM app_user WHERE email=$1`, [SECOND_ADMIN]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");
    await purge();

    const o = await owner.query<{ id: string }>(`SELECT id FROM app_user WHERE is_owner`);
    ownerId = o.rows[0]!.id;
    const a = await owner.query<{ id: string }>(
      `INSERT INTO app_user (email, full_name, role, password_hash, is_active)
       VALUES ($1, 'Second admin (probe)', 'admin', 'NO-LOGIN probe', true) RETURNING id`, [SECOND_ADMIN]);
    otherAdminId = a.rows[0]!.id;
    const c = await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, retenue_source, ice) VALUES ($1,'client',false,'000000000000002') RETURNING id`, [MARK]);
    companyId = c.rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (app) await app.end();
    if (!owner) return;
    await purge();
    await restoreDocumentCounters(owner);
    await owner.end();
  });

  /** An issued invoice for 12 000,00 TTC (10 000 HT + 20%). */
  async function issuedInvoice(): Promise<string> {
    const d = await owner.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ('facture', $1, 2000, false, 0, $2, $3) RETURNING id`, [companyId, MARK, ownerId]);
    const id = d.rows[0]!.id;
    await owner.query(
      `INSERT INTO document_line (document_id, label, unit, unit_price_centimes, quantity_millis, position)
       VALUES ($1, 'Production', 'forfait', 1000000, 1000, 0)`, [id]);
    await owner.query(`SELECT app.issue_document($1, 'virement')`, [id]);
    return id;
  }

  /** A payment, recorded through the application role by an administrator. */
  async function pay(docId: string, amount: bigint, by = otherAdminId): Promise<string> {
    await as(by, 'admin');
    const r = await app.query<{ id: string }>(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1, $2, 'cheque', '2026-11-01', $3) RETURNING id`, [docId, amount.toString(), by]);
    return r.rows[0]!.id;
  }

  async function reverse(docId: string, paymentId: string, amount: bigint, by: string, note: string | null = 'Cheque bounced') {
    await as(by, 'admin');
    return app.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, note, created_by_id, reverses_id)
       VALUES ($1, $2, 'virement', '2026-11-05', $3, $4, $5)`, [docId, (-amount).toString(), note, by, paymentId]);
  }

  const state = async (docId: string) =>
    (await owner.query<{ status: string; paid_at: string | null; paid: string; ledger: string; vat: string; rows: string }>(
      `SELECT d.status, d.paid_at::text,
              (SELECT coalesce(sum(amount_centimes),0)::text FROM document_payment WHERE document_id=d.id) AS paid,
              (SELECT coalesce(sum(amount_centimes),0)::text FROM finance_entry WHERE document_id=d.id) AS ledger,
              (SELECT coalesce(sum(vat_centimes),0)::text FROM finance_entry WHERE document_id=d.id) AS vat,
              (SELECT count(*)::text FROM document_payment WHERE document_id=d.id) AS rows
         FROM document d WHERE d.id=$1`, [docId])).rows[0]!;

  it('has exactly one owner: the earliest active administrator', async () => {
    const r = await owner.query<{ n: string; earliest: boolean }>(
      `SELECT count(*)::text AS n,
              bool_and(id = (SELECT id FROM app_user WHERE role='admin' AND is_active AND NOT is_service_account
                              AND email <> $1 ORDER BY created_at LIMIT 1)) AS earliest
         FROM app_user WHERE is_owner`, [SECOND_ADMIN]);
    expect(r.rows[0]).toEqual({ n: '1', earliest: true });
  });

  it('lets nobody make themselves owner through the application', async () => {
    // app_user is updatable by any admin and by everyone on their own row.
    await as(otherAdminId, 'admin');
    await expect(app.query(`UPDATE app_user SET is_owner = true WHERE id = $1`, [otherAdminId]))
      .rejects.toThrow(/owner is not chosen from the application/i);
    await as(ownerId, 'admin');
    await expect(app.query(`UPDATE app_user SET is_owner = false WHERE id = $1`, [ownerId]))
      .rejects.toThrow(/owner is not chosen from the application/i);
  });

  it('refuses a reversal from an administrator who is not the owner', async () => {
    const doc = await issuedInvoice();
    const p = await pay(doc, 500_000n);
    await expect(reverse(doc, p, 500_000n, otherAdminId)).rejects.toThrow(/only the owner/i);
    expect((await state(doc)).paid).toBe('500000');
  });

  it('lets the owner reverse a payment: both rows stay, the balance goes back up', async () => {
    const doc = await issuedInvoice();
    const p = await pay(doc, 500_000n);
    await reverse(doc, p, 500_000n, ownerId);

    const s = await state(doc);
    expect(s.rows, 'the original and its reversal are both on record').toBe('2');
    expect(s.paid).toBe('0');
    expect(s.status).toBe('emis');
    expect(s.ledger, 'the books net to nothing received').toBe('0');
    expect(s.vat).toBe('0');

    const ledger = await owner.query<{ amount: string; description: string }>(
      `SELECT amount_centimes::text AS amount, description FROM finance_entry WHERE document_id=$1 ORDER BY amount_centimes DESC`, [doc]);
    expect(ledger.rows.map((r) => r.amount)).toEqual(['500000', '-500000']);
    expect(ledger.rows[1]!.description).toMatch(/^Reversal of a payment on invoice/);
  });

  it('reopens a settled invoice when a reversal leaves it short, and it can settle again', async () => {
    const doc = await issuedInvoice();
    const p = await pay(doc, 1_200_000n);
    expect((await state(doc)).status).toBe('paye');

    await reverse(doc, p, 1_200_000n, ownerId);
    const reopened = await state(doc);
    expect(reopened.status).toBe('emis');
    expect(reopened.paid_at).toBeNull();

    await pay(doc, 1_200_000n);
    const settled = await state(doc);
    expect(settled.status).toBe('paye');
    expect(settled.ledger).toBe('1200000');
    expect(settled.vat, 'VAT on what is really paid: 2 000,00').toBe('200000');
  });

  it('refuses a partial, unexplained, repeated or nested reversal', async () => {
    const doc = await issuedInvoice();
    const p = await pay(doc, 600_000n);
    await expect(reverse(doc, p, 100_000n, ownerId)).rejects.toThrow(/exactly the amount/i);
    await expect(reverse(doc, p, 600_000n, ownerId, '  ')).rejects.toThrow(/say why/i);

    await reverse(doc, p, 600_000n, ownerId);
    await expect(reverse(doc, p, 600_000n, ownerId)).rejects.toThrow(/duplicate key|payment_reversed_once/i);

    const r = await owner.query<{ id: string }>(`SELECT id FROM document_payment WHERE reverses_id=$1`, [p]);
    await as(ownerId, 'admin');
    await expect(app.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, note, created_by_id, reverses_id)
       VALUES ($1, 600000, 'virement', '2026-11-06', 'undo', $2, $3)`, [doc, ownerId, r.rows[0]!.id],
    )).rejects.toThrow(/cannot itself be reversed|payment_reversal_negative/i);
  });

  it('never deletes a payment or a reversal, not even for the owner', async () => {
    const doc = await issuedInvoice();
    const p = await pay(doc, 300_000n);
    await as(ownerId, 'admin');
    await expect(app.query(`DELETE FROM document_payment WHERE id=$1`, [p])).rejects.toThrow(/never deleted/i);
  });

  it('lets nobody reopen a settled invoice by hand', async () => {
    const doc = await issuedInvoice();
    await pay(doc, 1_200_000n);
    await as(ownerId, 'admin');
    await expect(app.query(`UPDATE document SET status='emis' WHERE id=$1`, [doc]))
      .rejects.toThrow(/cannot move document/i);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { restoreDocumentCounters } from './test-support';

/**
 * Advance payments, proven at the database.
 *
 * The rules that matter:
 *   - the advance is any amount in DH, not a fixed share
 *   - each payment posts its own ledger line, real method, real date
 *   - the invoice settles itself when the money covers it — and the ledger
 *     lines for its instalments sum exactly to the invoice, VAT included
 *   - over-payment is refused, payments on quotes and drafts are refused
 *   - once settled, payments are locked accounting facts
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ payments probe';

describe.skipIf(!HAS_DB)('advance payments (integration)', () => {
  let db: Client;
  let companyId: string;
  let userId: string;

  async function purge() {
    await db.query(
      `DELETE FROM finance_entry WHERE company_id IN (SELECT id FROM company WHERE name=$1)`,
      [MARK],
    );
    await db.query(`ALTER TABLE document_payment DISABLE TRIGGER payment_delete_rules`);
    try {
      await db.query(
        `DELETE FROM document_payment WHERE document_id IN
           (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`,
        [MARK],
      );
    } finally {
      await db.query(`ALTER TABLE document_payment ENABLE TRIGGER payment_delete_rules`);
    }
    await db.query(
      `DELETE FROM document_line WHERE document_id IN
         (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`,
      [MARK],
    );
    await db.query(`ALTER TABLE document DISABLE TRIGGER document_immutable`);
    try {
      await db.query(
        `DELETE FROM document WHERE company_id IN (SELECT id FROM company WHERE name=$1)`,
        [MARK],
      );
    } finally {
      await db.query(`ALTER TABLE document ENABLE TRIGGER document_immutable`);
    }
    await db.query(`DELETE FROM company WHERE name=$1`, [MARK]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    const u = await db.query<{ id: string }>(`SELECT id FROM app_user WHERE role='admin' LIMIT 1`);
    userId = u.rows[0]!.id;
    await purge(); // a crashed earlier run must not fail this one
    const c = await db.query<{ id: string }>(
      `INSERT INTO company (name, status, retenue_source) VALUES ($1, 'client', false) RETURNING id`,
      [MARK],
    );
    companyId = c.rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await purge();
    // Issuing burns real numbers; give them back.
    await restoreDocumentCounters(db);
    await db.end();
  });

  /** An issued invoice for 10 000,00 HT + 20% = 12 000,00 TTC, no withholding. */
  async function issuedInvoice(): Promise<{ id: string; net: bigint }> {
    const d = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ('facture', $1, 2000, false, 0, $2, $3) RETURNING id`,
      [companyId, MARK, userId],
    );
    const id = d.rows[0]!.id;
    await db.query(
      `INSERT INTO document_line (document_id, label, unit, unit_price_centimes, quantity_millis, position)
       VALUES ($1, 'Production', 'forfait', 1000000, 1000, 0)`,
      [id],
    );
    await db.query(`SELECT app.issue_document($1)`, [id]);
    const n = await db.query<{ net: string }>(`SELECT net_to_collect::text AS net FROM document WHERE id=$1`, [id]);
    return { id, net: BigInt(n.rows[0]!.net) };
  }

  async function pay(docId: string, amount: bigint, method = 'virement', paidOn = '2026-08-29') {
    await db.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [docId, amount.toString(), method, paidOn, userId],
    );
  }

  it('takes a 10% advance in cash and the books see it that day', async () => {
    const { id, net } = await issuedInvoice();
    expect(net).toBe(1_200_000n);

    await pay(id, 120_000n, 'especes', '2026-08-01'); // 10%, cash

    const doc = await db.query<{ status: string }>(`SELECT status FROM document WHERE id=$1`, [id]);
    expect(doc.rows[0]!.status).toBe('emis'); // an advance does not settle it

    const entry = await db.query<{ amount: string; method: string; date: string; descr: string }>(
      `SELECT amount_centimes::text AS amount, payment_method AS method,
              entry_date::text AS date, description AS descr
         FROM finance_entry WHERE document_id=$1`,
      [id],
    );
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]!.amount).toBe('120000');
    expect(entry.rows[0]!.method).toBe('especes');
    expect(entry.rows[0]!.date).toBe('2026-08-01');
    expect(entry.rows[0]!.descr).toContain('Advance');
  });

  it('settles itself when the balance arrives, and the lines add up exactly', async () => {
    const { id, net } = await issuedInvoice();
    await pay(id, 350_000n, 'especes');            // an odd advance — not 50%
    await pay(id, net - 350_000n, 'virement');     // the balance

    const doc = await db.query<{ status: string; paid_at: string | null }>(
      `SELECT status, paid_at::date::text AS paid_at FROM document WHERE id=$1`, [id],
    );
    expect(doc.rows[0]!.status).toBe('paye');
    expect(doc.rows[0]!.paid_at).not.toBeNull();

    // Exactly the instalment lines — the whole-invoice posting must NOT fire.
    const sums = await db.query<{ n: string; amount: string; vat: string }>(
      `SELECT count(*)::text AS n, sum(amount_centimes)::text AS amount,
              sum(vat_centimes)::text AS vat
         FROM finance_entry WHERE document_id=$1`,
      [id],
    );
    expect(sums.rows[0]!.n).toBe('2');
    expect(sums.rows[0]!.amount).toBe(net.toString());
    expect(sums.rows[0]!.vat).toBe('200000'); // the invoice's full VAT, to the centime
  });

  it('refuses more than the remaining balance, naming the remainder', async () => {
    const { id, net } = await issuedInvoice();
    await pay(id, 1_000_000n);
    await expect(pay(id, net - 1_000_000n + 1n)).rejects.toThrow(/left to collect/);
  });

  it('refuses payments on a quote, pointing at the flow', async () => {
    const d = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ('devis', $1, 2000, false, 0, $2, $3) RETURNING id`,
      [companyId, MARK, userId],
    );
    await expect(pay(d.rows[0]!.id, 10_000n)).rejects.toThrow(/issue the invoice first/i);
  });

  it('refuses payments on a draft', async () => {
    const d = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ('facture', $1, 2000, false, 0, $2, $3) RETURNING id`,
      [companyId, MARK, userId],
    );
    await expect(pay(d.rows[0]!.id, 10_000n)).rejects.toThrow(/draft/i);
  });

  it('a deleted advance takes its ledger line with it', async () => {
    const { id } = await issuedInvoice();
    await pay(id, 200_000n);
    const p = await db.query<{ id: string }>(
      `SELECT id FROM document_payment WHERE document_id=$1`, [id],
    );
    await db.query(`DELETE FROM document_payment WHERE id=$1`, [p.rows[0]!.id]);

    const entries = await db.query(`SELECT 1 FROM finance_entry WHERE document_id=$1`, [id]);
    expect(entries.rows).toHaveLength(0);
  });

  it('locks the payments once the invoice is settled', async () => {
    const { id, net } = await issuedInvoice();
    await pay(id, net);
    const p = await db.query<{ id: string }>(
      `SELECT id FROM document_payment WHERE document_id=$1`, [id],
    );
    await expect(
      db.query(`DELETE FROM document_payment WHERE id=$1`, [p.rows[0]!.id]),
    ).rejects.toThrow(/settled|credit note/i);
    await expect(pay(id, 1n)).rejects.toThrow(/already settled/i);
  });

  it('a payment is never edited', async () => {
    const { id } = await issuedInvoice();
    await pay(id, 50_000n);
    await expect(
      db.query(
        `UPDATE document_payment SET amount_centimes = 60000
          WHERE document_id=$1`, [id],
      ),
    ).rejects.toThrow(/never edited/i);
  });

  it('marking paid by hand with no payments still posts the single line', async () => {
    const { id, net } = await issuedInvoice();
    await db.query(`UPDATE document SET status='paye', paid_at=now() WHERE id=$1`, [id]);
    const sums = await db.query<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n, sum(amount_centimes)::text AS amount
         FROM finance_entry WHERE document_id=$1`, [id],
    );
    expect(sums.rows[0]!.n).toBe('1');
    expect(sums.rows[0]!.amount).toBe(net.toString());
  });
});

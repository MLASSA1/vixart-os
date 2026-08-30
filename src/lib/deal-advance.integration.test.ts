import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { restoreDocumentCounters } from './test-support';

/**
 * How the agency gets paid: a share up front to start, the balance on delivery.
 *
 * The share is agreed while closing the DEAL, so it lives there, and an invoice
 * built from that deal inherits it. It is a term of the agreement — it records
 * what was promised, and never moves money by itself. Only a recorded payment
 * does that.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ advance probe';

describe.skipIf(!HAS_DB)('the advance, deal to invoice', () => {
  let db: Client;
  let companyId = '';
  let userId = '';

  async function purge() {
    await db.query(`DELETE FROM finance_entry WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    await db.query(`ALTER TABLE document_payment DISABLE TRIGGER payment_delete_rules`);
    await db.query(`ALTER TABLE document DISABLE TRIGGER document_immutable`);
    try {
      await db.query(`DELETE FROM document_payment WHERE document_id IN
        (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
      await db.query(`DELETE FROM document_line WHERE document_id IN
        (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
      await db.query(`DELETE FROM document WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    } finally {
      await db.query(`ALTER TABLE document_payment ENABLE TRIGGER payment_delete_rules`);
      await db.query(`ALTER TABLE document ENABLE TRIGGER document_immutable`);
    }
    await db.query(`DELETE FROM deal_line WHERE deal_id IN
      (SELECT d.id FROM deal d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
    await db.query(`DELETE FROM deal WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    await db.query(`DELETE FROM company WHERE name=$1`, [MARK]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await purge();
    userId = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' LIMIT 1`)).rows[0]!.id;
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, retenue_source) VALUES ($1,'client',false) RETURNING id`,
      [MARK])).rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await purge();
    await restoreDocumentCounters(db);
    await db.end();
  });

  /** A deal worth 20 000,00 HT with a 30% advance agreed: 7 200,00 of 24 000 TTC. */
  async function dealWithAdvance(advance: string) {
    const d = await db.query<{ id: string }>(
      `INSERT INTO deal (title, company_id, owner_id, stage, value_centimes, probability, advance_centimes)
       VALUES ($1,$2,$3,'won',2000000,100,$4) RETURNING id`,
      [MARK, companyId, userId, advance]);
    const dealId = d.rows[0]!.id;
    await db.query(
      `INSERT INTO deal_line (deal_id, label, unit, unit_price_centimes, quantity_millis, position)
       VALUES ($1,'Project','forfait',2000000,1000,0)`, [dealId]);
    return dealId;
  }

  async function invoiceFromDeal(dealId: string) {
    const doc = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, deal_id, vat_rate_bp, withholding,
                             withholding_rate_bp, client_name, created_by_id)
       VALUES ('facture',$1,$2,2000,false,0,$3,$4) RETURNING id`,
      [companyId, dealId, MARK, userId]);
    const id = doc.rows[0]!.id;
    await db.query(
      `INSERT INTO document_line (document_id, service_id, label, unit, unit_price_centimes, quantity_millis, position)
       SELECT $1, service_id, label, unit, unit_price_centimes, quantity_millis, position
         FROM deal_line WHERE deal_id=$2 ORDER BY position`, [id, dealId]);
    await db.query(
      `UPDATE document SET
         discount_centimes = (SELECT discount_centimes FROM deal WHERE id=$2),
         advance_expected_centimes = (SELECT advance_centimes FROM deal WHERE id=$2)
       WHERE id=$1`, [id, dealId]);
    return id;
  }

  it('carries the agreed advance from the deal onto the invoice', async () => {
    const dealId = await dealWithAdvance('720000');    // 7 200,00
    const invId = await invoiceFromDeal(dealId);

    const { rows } = await db.query<{ advance: string }>(
      `SELECT advance_expected_centimes::text AS advance FROM document WHERE id=$1`, [invId]);
    expect(rows[0]!.advance).toBe('720000');
  });

  it('moves no money by itself — an advance agreed is not an advance received', async () => {
    const dealId = await dealWithAdvance('720000');
    const invId = await invoiceFromDeal(dealId);
    await db.query(`SELECT app.issue_document($1)`, [invId]);

    const paid = await db.query(`SELECT 1 FROM document_payment WHERE document_id=$1`, [invId]);
    const ledger = await db.query(`SELECT 1 FROM finance_entry WHERE document_id=$1`, [invId]);
    const status = await db.query<{ s: string }>(`SELECT status AS s FROM document WHERE id=$1`, [invId]);

    expect(paid.rows).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
    expect(status.rows[0]!.s).toBe('emis');
  });

  it('the advance in, then the balance on delivery, settles it', async () => {
    const dealId = await dealWithAdvance('720000');
    const invId = await invoiceFromDeal(dealId);
    await db.query(`SELECT app.issue_document($1)`, [invId]);

    const net = BigInt((await db.query<{ n: string }>(
      `SELECT net_to_collect::text AS n FROM document WHERE id=$1`, [invId])).rows[0]!.n);
    expect(net).toBe(2400000n);   // 20 000 + 20% VAT

    await db.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1, 720000, 'virement', '2026-08-01', $2)`, [invId, userId]);
    let st = await db.query<{ s: string }>(`SELECT status AS s FROM document WHERE id=$1`, [invId]);
    expect(st.rows[0]!.s).toBe('emis');   // advance alone does not settle it

    await db.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1, 1680000, 'virement', '2026-09-15', $2)`, [invId, userId]);
    st = await db.query<{ s: string }>(`SELECT status AS s FROM document WHERE id=$1`, [invId]);
    expect(st.rows[0]!.s).toBe('paye');
  });

  it('freezes the agreed advance once the invoice is issued', async () => {
    const dealId = await dealWithAdvance('500000');
    const invId = await invoiceFromDeal(dealId);
    await db.query(`SELECT app.issue_document($1)`, [invId]);

    await expect(
      db.query(`UPDATE document SET advance_expected_centimes = 1 WHERE id=$1`, [invId]),
    ).rejects.toThrow(/cannot be modified/i);
  });

  it('refuses a negative advance on the deal', async () => {
    await expect(dealWithAdvance('-100')).rejects.toThrow();
  });

  it('a deal with no advance produces an invoice with none', async () => {
    const dealId = await dealWithAdvance('0');
    const invId = await invoiceFromDeal(dealId);
    const { rows } = await db.query<{ advance: string }>(
      `SELECT advance_expected_centimes::text AS advance FROM document WHERE id=$1`, [invId]);
    expect(rows[0]!.advance).toBe('0');
  });
});

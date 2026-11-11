import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { restoreDocumentCounters } from './test-support';

/**
 * What a client may see of the money (0085), and what they may not.
 *
 * The first time money crosses the client boundary. Written, like the boundary
 * test, mostly as refusals: a portal that shows a client their invoices looks
 * the same whether or not it also shows them somebody else's, or our drafts,
 * or why we reversed their cheque. Everything here runs as the real
 * `vixart_client` role.
 */

const URL = process.env.DATABASE_URL;
const CLIENT = process.env.CLIENT_DATABASE_URL;
const MARK = 'ZZZ billing probe';

async function reachable(): Promise<boolean> {
  if (!URL || !CLIENT) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('a client sees their own issued money (integration)', () => {
  let owner: Client;
  let portal: Client;
  let staffId = '';
  const mine = { company: '', contact: '', issued: '', paid: '', draft: '', quote: '', payment: '' };
  const theirs = { company: '', contact: '', issued: '' };

  async function asClient(contactId: string) {
    await portal.query(`SELECT set_config('app.client_contact_id', $1, false)`, [contactId]);
  }

  async function company(name: string) {
    const co = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source, ice)
       VALUES ($1,'client','client',false,'000000000000003') RETURNING id`, [`${MARK} ${name}`])).rows[0]!.id;
    const ct = (await owner.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email) VALUES ($1,$2,$3) RETURNING id`,
      [co, `${MARK} ${name}`, `zzz-billing-${name}@example.invalid`])).rows[0]!.id;
    await owner.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',$2)`, [ct, staffId]);
    return { co, ct };
  }

  async function doc(companyId: string, type: 'facture' | 'devis', issue: boolean): Promise<string> {
    const id = (await owner.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ($1,$2,2000,false,0,$3,$4) RETURNING id`, [type, companyId, MARK, staffId])).rows[0]!.id;
    await owner.query(
      `INSERT INTO document_line (document_id, label, unit, unit_price_centimes, quantity_millis, position)
       VALUES ($1,'Production','forfait',1000000,1000,0)`, [id]);
    if (issue) await owner.query(`SELECT app.issue_document($1, 'virement')`, [id]);
    return id;
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    const docs = `(SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name LIKE '${MARK}%')`;
    await owner.query(`DELETE FROM finance_entry WHERE document_id IN ${docs}`);
    await owner.query(`ALTER TABLE document_payment DISABLE TRIGGER payment_delete_rules`);
    try {
      await owner.query(`DELETE FROM document_payment WHERE reverses_id IS NOT NULL AND document_id IN ${docs}`);
      await owner.query(`DELETE FROM document_payment WHERE document_id IN ${docs}`);
    } finally {
      await owner.query(`ALTER TABLE document_payment ENABLE TRIGGER payment_delete_rules`);
    }
    await owner.query(`DELETE FROM document_line WHERE document_id IN ${docs}`);
    await owner.query(`ALTER TABLE document DISABLE TRIGGER document_immutable`);
    try {
      await owner.query(`DELETE FROM document WHERE id IN ${docs}`);
    } finally {
      await owner.query(`ALTER TABLE document ENABLE TRIGGER document_immutable`);
    }
    await owner.query(`DELETE FROM client_account WHERE contact_id IN (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    staffId = (await owner.query<{ id: string }>(`SELECT id FROM app_user WHERE is_owner`)).rows[0]!.id;

    const a = await company('mine');
    const b = await company('theirs');
    Object.assign(mine, { company: a.co, contact: a.ct });
    Object.assign(theirs, { company: b.co, contact: b.ct });

    mine.issued = await doc(a.co, 'facture', true);
    mine.paid = await doc(a.co, 'facture', true);
    mine.draft = await doc(a.co, 'facture', false);
    mine.quote = await doc(a.co, 'devis', true);
    theirs.issued = await doc(b.co, 'facture', true);

    mine.payment = (await owner.query<{ id: string }>(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, note, created_by_id)
       VALUES ($1, 1200000, 'virement', '2026-11-02', 'internal: chased twice', $2) RETURNING id`,
      [mine.paid, staffId])).rows[0]!.id;
    await owner.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1, 300000, 'cheque', '2026-11-03', $2)`, [theirs.issued, staffId]);

    portal = new Client({ connectionString: CLIENT });
    await portal.connect();
  });

  afterAll(async () => {
    if (portal) await portal.end();
    if (!owner) return;
    await purge();
    await restoreDocumentCounters(owner);
    await owner.end();
  });

  it('sees its own issued and paid documents, quotes included, and nothing else', async () => {
    await asClient(mine.contact);
    const r = await portal.query<{ id: string }>(`SELECT id FROM document`);
    expect(r.rows.map((x) => x.id).sort()).toEqual([mine.issued, mine.paid, mine.quote].sort());
  });

  it('never sees a draft, even by its id', async () => {
    await asClient(mine.contact);
    expect((await portal.query(`SELECT id FROM document WHERE id=$1`, [mine.draft])).rowCount).toBe(0);
    expect((await portal.query(`SELECT id FROM document_line WHERE document_id=$1`, [mine.draft])).rowCount).toBe(0);
  });

  it("never sees another client's documents, lines or payments", async () => {
    await asClient(mine.contact);
    expect((await portal.query(`SELECT id FROM document WHERE id=$1`, [theirs.issued])).rowCount).toBe(0);
    expect((await portal.query(`SELECT id FROM document_line WHERE document_id=$1`, [theirs.issued])).rowCount).toBe(0);
    expect((await portal.query(`SELECT id FROM document_payment WHERE document_id=$1`, [theirs.issued])).rowCount).toBe(0);

    await asClient(theirs.contact);
    const r = await portal.query<{ id: string }>(`SELECT id FROM document`);
    expect(r.rows.map((x) => x.id)).toEqual([theirs.issued]);
  });

  it('sees its payments, but not our note on them nor who recorded them', async () => {
    await asClient(mine.contact);
    const r = await portal.query<{ id: string; amount_centimes: string }>(
      `SELECT id, amount_centimes::text FROM document_payment`);
    expect(r.rows).toEqual([{ id: mine.payment, amount_centimes: '1200000' }]);
    await expect(portal.query(`SELECT note FROM document_payment`)).rejects.toThrow(/permission denied/i);
    await expect(portal.query(`SELECT created_by_id FROM document_payment`)).rejects.toThrow(/permission denied/i);
    await expect(portal.query(`SELECT created_by_id FROM document`)).rejects.toThrow(/permission denied/i);
    await expect(portal.query(`SELECT deal_id FROM document`)).rejects.toThrow(/permission denied/i);
  });

  it('cannot see anything without a client session', async () => {
    await portal.query(`SELECT set_config('app.client_contact_id', '', false)`);
    expect((await portal.query(`SELECT id FROM document`)).rowCount).toBe(0);
    expect((await portal.query(`SELECT id FROM document_payment`)).rowCount).toBe(0);
  });

  it('can change nothing: no payment, no edit, no delete', async () => {
    await asClient(mine.contact);
    await expect(portal.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on) VALUES ($1, 100, 'virement', '2026-11-04')`,
      [mine.issued])).rejects.toThrow(/permission denied/i);
    await expect(portal.query(`UPDATE document SET status='paye' WHERE id=$1`, [mine.issued]))
      .rejects.toThrow(/permission denied/i);
    await expect(portal.query(`DELETE FROM document_line WHERE document_id=$1`, [mine.issued]))
      .rejects.toThrow(/permission denied/i);
  });
});

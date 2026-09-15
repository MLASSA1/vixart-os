import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { restoreDocumentCounters } from './test-support';

/**
 * The purge, run against rows that actually exist.
 *
 * It was written to hand-cross the RESTRICT edges a plain cascade cannot —
 * finance_entry and document_payment both restrict document, and a credit note
 * restricts the invoice it corrects — and then only ever executed against an
 * empty table. Logic that has never deleted a row is not safe, it is untried.
 *
 * So: build a probe client with the whole graph hanging off it, including an
 * issued and settled invoice and a credit note pointing back at it, purge, and
 * check both halves — everything of the probe's gone, everything else intact.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const PROBE = 'ZZZ purge probe';
const KEEP = 'ZZZKeepMe SARL';   // no space: must survive

describe.skipIf(!HAS_DB)('purging a populated probe company', () => {
  let db: Client;
  let userId = '';
  let companyId = '';
  let keepId = '';
  let invoiceId = '';
  let creditId = '';
  let projectId = '';
  let taskId = '';

  async function scrub() {
    // Tear the fixture down by hand if the purge itself failed, so a bad run
    // cannot poison the next.
    await db.query(`DELETE FROM finance_entry WHERE company_id IN (SELECT id FROM company WHERE name IN ($1,$2))`, [PROBE, KEEP]);
    await db.query(`ALTER TABLE document_payment DISABLE TRIGGER payment_delete_rules`);
    try {
      await db.query(`DELETE FROM document_payment WHERE document_id IN
        (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name IN ($1,$2))`, [PROBE, KEEP]);
    } finally {
      await db.query(`ALTER TABLE document_payment ENABLE TRIGGER payment_delete_rules`);
    }
    await db.query(`UPDATE document SET corrects_id=NULL WHERE company_id IN (SELECT id FROM company WHERE name IN ($1,$2))`, [PROBE, KEEP]);
    await db.query(`DELETE FROM document WHERE company_id IN (SELECT id FROM company WHERE name IN ($1,$2))`, [PROBE, KEEP]);
    await db.query(`DELETE FROM company WHERE name IN ($1,$2)`, [PROBE, KEEP]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await scrub();

    userId = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' LIMIT 1`)).rows[0]!.id;

    // A client that only LOOKS like a probe. It must survive.
    keepId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [KEEP])).rows[0]!.id;

    // The probe, with everything hanging off it.
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [PROBE])).rows[0]!.id;

    await db.query(`INSERT INTO contact (company_id, full_name) VALUES ($1,'Probe Contact')`, [companyId]);
    await db.query(
      `INSERT INTO interaction (company_id, kind, author_id, author_name, title, body)
       VALUES ($1,'note',$2,'Probe','probe note','probe body')`,
      [companyId, userId]);

    const dealId = (await db.query<{ id: string }>(
      `INSERT INTO deal (title, company_id, owner_id, stage, value_centimes, probability)
       VALUES ($1,$2,$3,'won',500000,100) RETURNING id`, [PROBE, companyId, userId])).rows[0]!.id;
    await db.query(
      `INSERT INTO deal_line (deal_id, label, unit, unit_price_centimes, quantity_millis, position)
       VALUES ($1,'Line','forfait',500000,1000,0)`, [dealId]);

    projectId = (await db.query<{ id: string }>(
      `INSERT INTO project (name, company_id, status, project_type)
       VALUES ($1,$2,'active','branding') RETURNING id`, [PROBE, companyId])).rows[0]!.id;
    taskId = (await db.query<{ id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, status, priority)
       VALUES ($1,$2,$3,'todo','normal') RETURNING id`, [PROBE, projectId, userId])).rows[0]!.id;

    // An ISSUED, SETTLED invoice: this is what creates the RESTRICT edges.
    invoiceId = (await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp,
                             client_name, created_by_id)
       VALUES ('facture',$1,2000,false,0,$2,$3) RETURNING id`,
      [companyId, PROBE, userId])).rows[0]!.id;
    await db.query(
      `INSERT INTO document_line (document_id,label,unit,unit_price_centimes,quantity_millis,position)
       VALUES ($1,'Work','forfait',500000,1000,0)`, [invoiceId]);
    await db.query(`SELECT app.issue_document($1)`, [invoiceId]);

    const net = (await db.query<{ n: string }>(
      `SELECT net_to_collect::text AS n FROM document WHERE id=$1`, [invoiceId])).rows[0]!.n;
    // Settling it posts a finance_entry AND locks the payment behind its
    // delete guard — both edges the purge has to cross.
    await db.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1,$2,'virement',current_date,$3)`, [invoiceId, net, userId]);

    // A credit note pointing back at it: the corrects_id RESTRICT.
    creditId = (await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp,
                             client_name, created_by_id, corrects_id)
       VALUES ('avoir',$1,2000,false,0,$2,$3,$4) RETURNING id`,
      [companyId, PROBE, userId, invoiceId])).rows[0]!.id;

    // Polymorphic children that no foreign key would carry away.
    await db.query(
      `INSERT INTO comment (entity_type, entity_id, author_id, author_name, body)
       VALUES ('task',$1,$2,'Probe','probe comment'), ('project',$3,$2,'Probe','probe comment')`,
      [taskId, userId, projectId]);
  });

  afterAll(async () => {
    if (!db) return;
    await scrub();
    await restoreDocumentCounters(db);
    await db.end();
  });

  it('built a probe with every restricting edge present', async () => {
    const q = async (sql: string, p: unknown[]) =>
      Number((await db.query<{ n: string }>(sql, p)).rows[0]!.n);
    expect(await q(`SELECT count(*)::text AS n FROM finance_entry WHERE document_id=$1`, [invoiceId])).toBe(1);
    expect(await q(`SELECT count(*)::text AS n FROM document_payment WHERE document_id=$1`, [invoiceId])).toBe(1);
    expect(await q(`SELECT count(*)::text AS n FROM document WHERE corrects_id=$1`, [invoiceId])).toBe(1);
    // The settled invoice's payment is locked — proving the guard is live.
    await expect(
      db.query(`DELETE FROM document_payment WHERE document_id=$1`, [invoiceId]),
    ).rejects.toThrow(/settled|credit note/i);
  });

  it('purges the probe and reports one company removed', async () => {
    const n = Number((await db.query<{ n: string }>(
      `SELECT app.purge_probe_companies() AS n`)).rows[0]!.n);
    expect(n).toBe(1);
  });

  it('left nothing of the probe behind', async () => {
    const gone = async (sql: string, p: unknown[]) =>
      Number((await db.query<{ n: string }>(sql, p)).rows[0]!.n);
    expect(await gone(`SELECT count(*)::text AS n FROM company WHERE id=$1`, [companyId])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM document WHERE id=ANY($1)`, [[invoiceId, creditId]])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM document_line WHERE document_id=$1`, [invoiceId])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM document_payment WHERE document_id=$1`, [invoiceId])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM finance_entry WHERE document_id=$1`, [invoiceId])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM project WHERE id=$1`, [projectId])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM task WHERE id=$1`, [taskId])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM contact WHERE company_id=$1`, [companyId])).toBe(0);
    expect(await gone(`SELECT count(*)::text AS n FROM comment WHERE entity_id=ANY($1)`, [[taskId, projectId]])).toBe(0);
  });

  it('restored the payment delete guard it had to lift', async () => {
    const { rows } = await db.query<{ enabled: string }>(
      `SELECT tgenabled AS enabled FROM pg_trigger WHERE tgname='payment_delete_rules'`);
    expect(rows[0]!.enabled).toBe('O');   // 'O' = enabled
  });

  it('left the lookalike client untouched', async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM company WHERE id=$1`, [keepId]);
    expect(rows[0]?.name).toBe(KEEP);
  });

  it('left the activity log alone', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM activity WHERE entity_id=$1`, [companyId]);
    // The company is gone; the record that it existed is not.
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('is harmless when run again with nothing to do', async () => {
    const n = Number((await db.query<{ n: string }>(
      `SELECT app.purge_probe_companies() AS n`)).rows[0]!.n);
    expect(n).toBe(0);
  });
});

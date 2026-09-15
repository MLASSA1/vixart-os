import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Retainers: a committed term, billed as a draft, never as an invoice.
 *
 * The term is the part that matters. An open-ended monthly lets a client take
 * the first month — the audit, the brand work, the setup — and leave before any
 * of it compounds. So the tests check the commitment as hard as the billing.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ retainer probe';

describe.skipIf(!HAS_DB)('retainers (integration)', () => {
  let db: Client;
  let companyId = '';
  let userId = '';

  async function purge() {
    await db.query(`DELETE FROM document_line WHERE document_id IN
      (SELECT d.id FROM document d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
    await db.query(`ALTER TABLE document DISABLE TRIGGER document_immutable`);
    try {
      await db.query(`DELETE FROM document WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    } finally {
      await db.query(`ALTER TABLE document ENABLE TRIGGER document_immutable`);
    }
    await db.query(`DELETE FROM retainer WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    await db.query(`DELETE FROM company WHERE name=$1`, [MARK]);
  }

  /** A retainer, with the knobs the amendment introduced. */
  async function make(opts: {
    start: string; term?: number; auto?: boolean; day?: number;
    status?: string; monthly?: number; end?: string | null;
  }) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO retainer (company_id, label, monthly_centimes, vat_rate_bp, start_date,
                             term_months, auto_renew, billing_day, status, end_date, created_by_id)
       VALUES ($1,'Social media',$2,2000,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [companyId, String(opts.monthly ?? 600000), opts.start, opts.term ?? 3,
       opts.auto ?? true, opts.day ?? 1, opts.status ?? 'active', opts.end ?? null, userId]);
    return r.rows[0]!.id;
  }

  const draft = async (today: string) =>
    Number((await db.query<{ n: string }>(
      `SELECT app.draft_retainer_invoices($1) AS n`, [today])).rows[0]!.n);

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await purge();
    userId = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' LIMIT 1`)).rows[0]!.id;
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [MARK])).rows[0]!.id;
  });

  afterAll(async () => { if (db) { await purge(); await db.end(); } });

  // --- the committed term --------------------------------------------------

  it('holds the client inside the term they committed to', async () => {
    const inside = await db.query<{ b: boolean }>(
      `SELECT app.retainer_in_committed_term('2026-01-01', 3, '2026-03-31') AS b`);
    const after = await db.query<{ b: boolean }>(
      `SELECT app.retainer_in_committed_term('2026-01-01', 3, '2026-04-01') AS b`);
    expect(inside.rows[0]!.b).toBe(true);
    expect(after.rows[0]!.b).toBe(false);
  });

  it('rolls the term forward while it auto-renews', async () => {
    const { rows } = await db.query<{ d: string }>(
      `SELECT app.retainer_term_end('2026-01-01',3,true,NULL,'2026-07-15')::text AS d`);
    expect(rows[0]!.d).toBe('2026-10-01');
  });

  it('stops at the first term when it does not renew', async () => {
    const { rows } = await db.query<{ d: string }>(
      `SELECT app.retainer_term_end('2026-01-01',3,false,NULL,'2026-09-01')::text AS d`);
    expect(rows[0]!.d).toBe('2026-04-01');
  });

  it('lets a negotiated end date win over the derived one', async () => {
    const { rows } = await db.query<{ d: string }>(
      `SELECT app.retainer_term_end('2026-01-01',3,true,'2026-02-15','2026-09-01')::text AS d`);
    expect(rows[0]!.d).toBe('2026-02-15');
  });

  it('refuses to end without recording why', async () => {
    const id = await make({ start: '2026-01-01' });
    await expect(
      db.query(`UPDATE retainer SET status='ended' WHERE id=$1`, [id]),
    ).rejects.toThrow(/retainer_ended_needs_reason/);
    // With a reason it is allowed, even inside the committed term.
    await db.query(
      `UPDATE retainer SET status='ended', end_reason='Went in-house', ended_on='2026-02-01' WHERE id=$1`, [id]);
    const { rows } = await db.query<{ s: string }>(`SELECT status AS s FROM retainer WHERE id=$1`, [id]);
    expect(rows[0]!.s).toBe('ended');
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  // --- drafting ------------------------------------------------------------

  it('drafts one invoice on the billing day, with the right line', async () => {
    const id = await make({ start: '2026-01-01', day: 5, monthly: 600000 });
    expect(await draft('2026-03-05')).toBe(1);

    const { rows } = await db.query<{ status: string; number: string | null; period: string; issue: string }>(
      `SELECT status, number, retainer_period AS period, issue_date::text AS issue
         FROM document WHERE retainer_id=$1`, [id]);
    expect(rows).toHaveLength(1);
    // A DRAFT. No number, no legal standing, no money moved.
    expect(rows[0]!.status).toBe('brouillon');
    expect(rows[0]!.number).toBeNull();
    expect(rows[0]!.period).toBe('2026-03');
    // Dated the billing day, not the day the job happened to run.
    expect(rows[0]!.issue).toBe('2026-03-05');

    const line = await db.query<{ amount: string; label: string }>(
      `SELECT unit_price_centimes::text AS amount, label FROM document_line
        WHERE document_id = (SELECT id FROM document WHERE retainer_id=$1)`, [id]);
    expect(line.rows[0]!.amount).toBe('600000');
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  it('is idempotent however many times the job runs', async () => {
    await purge();
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [MARK])).rows[0]!.id;
    const id = await make({ start: '2026-01-01', day: 1 });

    expect(await draft('2026-04-01')).toBe(1);
    expect(await draft('2026-04-01')).toBe(0);   // a restart
    expect(await draft('2026-04-20')).toBe(0);   // later the same month

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document WHERE retainer_id=$1`, [id]);
    expect(rows[0]!.n).toBe('1');

    // A different month is a different draft.
    expect(await draft('2026-05-01')).toBe(1);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  it('drafts nothing for a paused retainer', async () => {
    await purge();
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [MARK])).rows[0]!.id;
    const id = await make({ start: '2026-01-01', status: 'paused' });
    expect(await draft('2026-04-01')).toBe(0);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  it('drafts nothing after the term has expired', async () => {
    const id = await make({ start: '2026-01-01', term: 3, auto: false, day: 1 });
    // The term ended 2026-04-01 and it does not renew.
    expect(await draft('2026-05-01')).toBe(0);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  it('drafts nothing past an explicitly negotiated end date', async () => {
    const id = await make({ start: '2026-01-01', end: '2026-02-15', day: 1 });
    expect(await draft('2026-03-01')).toBe(0);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  it('drafts nothing before the billing day arrives', async () => {
    const id = await make({ start: '2026-01-01', day: 20 });
    expect(await draft('2026-04-19')).toBe(0);
    expect(await draft('2026-04-20')).toBe(1);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });


  // --- the cases that cost money: billing a client who has left ------------
  //
  // Each of these proves the retainer DID draft while it was live and then
  // stopped. A test that only asserts 0 would pass against a function that
  // never drafted anything at all.

  it('a non-renewing term drafts while live, then nothing the following period', async () => {
    await purge();
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [MARK])).rows[0]!.id;

    // Three months from 1 January, does NOT renew: the term ends 2026-04-01.
    const id = await make({ start: '2026-01-01', term: 3, auto: false, day: 1 });

    // Inside the term it bills, so the mechanism is known to work.
    expect(await draft('2026-02-01')).toBe(1);
    expect(await draft('2026-03-01')).toBe(1);

    // April IS the expiry date — the term is over, so April is not billable.
    expect(await draft('2026-04-01')).toBe(0);
    // And the following period, which is the one that would reach a client
    // who has already gone.
    expect(await draft('2026-05-01')).toBe(0);
    expect(await draft('2026-06-01')).toBe(0);

    const { rows } = await db.query<{ periods: string }>(
      `SELECT coalesce(string_agg(retainer_period, ',' ORDER BY retainer_period), '') AS periods
         FROM document WHERE retainer_id=$1`, [id]);
    expect(rows[0]!.periods).toBe('2026-02,2026-03');
    await db.query(`DELETE FROM document WHERE retainer_id=$1`, [id]);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  it('a retainer ended early inside its term stops drafting from that point', async () => {
    await purge();
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [MARK])).rows[0]!.id;

    // Twelve-month commitment, renewing — a long way from its natural end.
    const id = await make({ start: '2026-01-01', term: 12, auto: true, day: 1 });

    expect(await draft('2026-02-01')).toBe(1);
    expect(await draft('2026-03-01')).toBe(1);

    // The client leaves in March, eight months inside the commitment. This is
    // exactly what endRetainerAction writes: status, reason, and the end date.
    await db.query(
      `UPDATE retainer
          SET status='ended', end_reason='Went in-house', ended_on='2026-03-20', end_date='2026-03-20'
        WHERE id=$1`, [id]);

    // Nothing from here on, including the months it would still have been
    // inside its committed term.
    expect(await draft('2026-04-01')).toBe(0);
    expect(await draft('2026-05-01')).toBe(0);
    expect(await draft('2027-01-01')).toBe(0);

    const { rows } = await db.query<{ periods: string }>(
      `SELECT coalesce(string_agg(retainer_period, ',' ORDER BY retainer_period), '') AS periods
         FROM document WHERE retainer_id=$1`, [id]);
    expect(rows[0]!.periods).toBe('2026-02,2026-03');
    await db.query(`DELETE FROM document WHERE retainer_id=$1`, [id]);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  it('an end date alone stops it, even with the status left active', async () => {
    // Belt and braces: the status check and the term check are independent, so
    // neither one carries the rule alone.
    await purge();
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [MARK])).rows[0]!.id;

    const id = await make({ start: '2026-01-01', term: 12, auto: true, day: 1 });
    expect(await draft('2026-02-01')).toBe(1);

    await db.query(`UPDATE retainer SET end_date='2026-02-20' WHERE id=$1`, [id]);
    expect(await draft('2026-03-01')).toBe(0);

    await db.query(`DELETE FROM document WHERE retainer_id=$1`, [id]);
    await db.query(`DELETE FROM retainer WHERE id=$1`, [id]);
  });

  // --- MRR -----------------------------------------------------------------

  it('counts only active retainers towards MRR', async () => {
    await purge();
    companyId = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source)
       VALUES ($1,'client','client',false) RETURNING id`, [MARK])).rows[0]!.id;

    await make({ start: '2026-01-01', monthly: 600000 });
    await make({ start: '2026-01-01', monthly: 400000 });
    await make({ start: '2026-01-01', monthly: 900000, status: 'paused' });
    const ended = await make({ start: '2026-01-01', monthly: 1500000 });
    await db.query(
      `UPDATE retainer SET status='ended', end_reason='Budget cut' WHERE id=$1`, [ended]);

    const { rows } = await db.query<{ mrr: string; n: string }>(
      `SELECT coalesce(sum(monthly_centimes),0)::text AS mrr, count(*)::text AS n
         FROM retainer WHERE status='active' AND company_id=$1`, [companyId]);
    expect(rows[0]!.mrr).toBe('1000000');   // 6 000 + 4 000, not the paused or ended
    expect(rows[0]!.n).toBe('2');
  });

  it('refuses a member any sight of retainers', async () => {
    const app = process.env.APP_DATABASE_URL;
    if (!app) return;
    const c = new Client({ connectionString: app });
    await c.connect();
    try {
      const member = await db.query<{ id: string }>(
        `SELECT id FROM app_user WHERE role='member' AND is_assignable LIMIT 1`);
      await c.query(`SELECT set_config('app.user_id',$1,false)`, [member.rows[0]!.id]);
      await c.query(`SELECT set_config('app.user_role','member',false)`);
      const { rows } = await c.query(`SELECT 1 FROM retainer`);
      expect(rows).toHaveLength(0);
    } finally { await c.end(); }
  });
});

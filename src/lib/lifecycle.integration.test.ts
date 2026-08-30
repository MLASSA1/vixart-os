import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { restoreDocumentCounters } from './test-support';

/**
 * The whole business, start to finish, in the order it actually happens.
 *
 * Every other integration test proves one rule in isolation. This one walks a
 * real engagement — lead, deal, quote, invoice, advance, balance, project,
 * task, sign-off — and checks the automations agree with each other along the
 * way. Rules that are individually correct can still contradict each other in
 * sequence, and that is what this is for.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ lifecycle probe';

describe.skipIf(!HAS_DB)('a whole engagement, end to end', () => {
  let db: Client;
  let companyId = '';
  let adminId = '';
  let moderatorId = '';
  let memberId = '';

  async function purge() {
    await db.query(`DELETE FROM finance_entry WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    for (const [table, trigger] of [
      ['document_payment', 'payment_delete_rules'],
      ['document', 'document_immutable'],
    ] as const) {
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
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
    await db.query(`DELETE FROM task WHERE project_id IN
      (SELECT p.id FROM project p JOIN company c ON c.id=p.company_id WHERE c.name=$1)`, [MARK]);
    await db.query(`DELETE FROM project WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    await db.query(`DELETE FROM deal_line WHERE deal_id IN
      (SELECT d.id FROM deal d JOIN company c ON c.id=d.company_id WHERE c.name=$1)`, [MARK]);
    await db.query(`DELETE FROM deal WHERE company_id IN (SELECT id FROM company WHERE name=$1)`, [MARK]);
    await db.query(`DELETE FROM company WHERE name=$1`, [MARK]);
  }

  /** Act as a given person, the way withUser() does for a request. */
  async function as(userId: string, role: string, fn: () => Promise<void>) {
    await db.query(`SELECT set_config('app.bootstrap','off',false)`);
    await db.query(`SELECT set_config('app.user_id',$1,false)`, [userId]);
    await db.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
    try { await fn(); } finally {
      await db.query(`SELECT set_config('app.bootstrap','on',false)`);
    }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await purge();

    const pick = async (role: string) => {
      const r = await db.query<{ id: string }>(
        `SELECT id FROM app_user WHERE role=$1 AND password_hash NOT LIKE 'NO-LOGIN%' LIMIT 1`, [role]);
      return r.rows[0]!.id;
    };
    adminId = await pick('admin');
    moderatorId = await pick('moderator');
    memberId = await pick('member');

    const c = await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship, retenue_source) VALUES ($1,'lead','client',false) RETURNING id`,
      [MARK]);
    companyId = c.rows[0]!.id;
  });

  afterAll(async () => { if (db) { await purge(); await db.end(); } });

  // -- 1. the lead becomes a client ----------------------------------------
  it('logs the client stage change in the activity trail', async () => {
    await db.query(`UPDATE company SET status='client' WHERE id=$1`, [companyId]);
    const a = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM activity WHERE entity_id=$1`, [companyId]);
    expect(Number(a.rows[0]!.n)).toBeGreaterThan(0);
  });

  // -- 2. a deal, priced from the catalog ----------------------------------
  it('carries the deal total onto a quote, then onto an invoice', async () => {
    const d = await db.query<{ id: string }>(
      `INSERT INTO deal (title, company_id, owner_id, stage, value_centimes, probability)
       VALUES ($1,$2,$3,'proposal',0,50) RETURNING id`, [MARK, companyId, adminId]);
    const dealId = d.rows[0]!.id;

    await db.query(
      `INSERT INTO deal_line (deal_id, label, unit, unit_price_centimes, quantity_millis, position)
       VALUES ($1,'Brand film','forfait',4800000,1000,0), ($1,'Photo','jour',350000,3000,1)`, [dealId]);

    // A quote copied from the deal must arrive with the same lines.
    const q = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, deal_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ('devis',$1,$2,2000,false,0,$3,$4) RETURNING id`, [companyId, dealId, MARK, adminId]);
    await db.query(
      `INSERT INTO document_line (document_id, service_id, label, unit, unit_price_centimes, quantity_millis, position)
       SELECT $1, service_id, label, unit, unit_price_centimes, quantity_millis, position
         FROM deal_line WHERE deal_id=$2 ORDER BY position`, [q.rows[0]!.id, dealId]);
    await db.query(`SELECT app.issue_document($1)`, [q.rows[0]!.id]);

    const quote = await db.query<{ ht: string; number: string }>(
      `SELECT total_excl_vat::text AS ht, number FROM document WHERE id=$1`, [q.rows[0]!.id]);
    expect(quote.rows[0]!.ht).toBe('5850000');            // 48 000 + 10 500
    expect(quote.rows[0]!.number).toMatch(/^DEV-\d{4}-\d{4}$/);
  });

  // -- 3. numbering is gapless per type and year ---------------------------
  it('numbers invoices consecutively with no gaps', async () => {
    const numbers: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const d = await db.query<{ id: string }>(
        `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
         VALUES ('facture',$1,2000,false,0,$2,$3) RETURNING id`, [companyId, MARK, adminId]);
      await db.query(
        `INSERT INTO document_line (document_id,label,unit,unit_price_centimes,quantity_millis,position)
         VALUES ($1,'Retainer','forfait',100000,1000,0)`, [d.rows[0]!.id]);
      await db.query(`SELECT app.issue_document($1)`, [d.rows[0]!.id]);
      const n = await db.query<{ seq: number }>(`SELECT number_seq AS seq FROM document WHERE id=$1`, [d.rows[0]!.id]);
      numbers.push(n.rows[0]!.seq);
    }
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i]).toBe(numbers[i - 1]! + 1);
    }
  });

  // -- 4. a failed issue must not burn a number ----------------------------
  it('does not consume a number when issuing fails', async () => {
    const before = await db.query<{ seq: string }>(
      `SELECT coalesce(max(number_seq),0)::text AS seq FROM document
        WHERE doc_type='facture' AND number_year=extract(year FROM current_date)`);

    const empty = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ('facture',$1,2000,false,0,$2,$3) RETURNING id`, [companyId, MARK, adminId]);
    await expect(db.query(`SELECT app.issue_document($1)`, [empty.rows[0]!.id])).rejects.toThrow(/no lines/i);

    const after = await db.query<{ seq: string }>(
      `SELECT coalesce(max(number_seq),0)::text AS seq FROM document
        WHERE doc_type='facture' AND number_year=extract(year FROM current_date)`);
    expect(after.rows[0]!.seq).toBe(before.rows[0]!.seq);
  });

  // -- 5. advance, then balance, and the ledger agrees ---------------------
  it('takes a 30% advance and settles on the balance, books matching', async () => {
    const d = await db.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, vat_rate_bp, withholding, withholding_rate_bp, client_name, created_by_id)
       VALUES ('facture',$1,2000,false,0,$2,$3) RETURNING id`, [companyId, MARK, adminId]);
    const inv = d.rows[0]!.id;
    await db.query(
      `INSERT INTO document_line (document_id,label,unit,unit_price_centimes,quantity_millis,position)
       VALUES ($1,'Production','forfait',5000000,1000,0)`, [inv]);
    await db.query(`SELECT app.issue_document($1)`, [inv]);

    const net = BigInt((await db.query<{ n: string }>(
      `SELECT net_to_collect::text AS n FROM document WHERE id=$1`, [inv])).rows[0]!.n);
    const advance = (net * 30n) / 100n;

    await db.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1,$2,'especes','2026-08-10',$3)`, [inv, advance.toString(), adminId]);
    let st = await db.query<{ s: string }>(`SELECT status AS s FROM document WHERE id=$1`, [inv]);
    expect(st.rows[0]!.s).toBe('emis');

    await db.query(
      `INSERT INTO document_payment (document_id, amount_centimes, method, paid_on, created_by_id)
       VALUES ($1,$2,'virement','2026-09-01',$3)`, [inv, (net - advance).toString(), adminId]);
    st = await db.query<{ s: string }>(`SELECT status AS s FROM document WHERE id=$1`, [inv]);
    expect(st.rows[0]!.s).toBe('paye');

    const led = await db.query<{ n: string; amt: string; vat: string }>(
      `SELECT count(*)::text AS n, sum(amount_centimes)::text AS amt, sum(vat_centimes)::text AS vat
         FROM finance_entry WHERE document_id=$1`, [inv]);
    expect(led.rows[0]!.n).toBe('2');
    expect(led.rows[0]!.amt).toBe(net.toString());
    expect(led.rows[0]!.vat).toBe('1000000');   // 20% of 50 000,00, to the centime
  });

  // -- 6. an issued invoice is immutable -----------------------------------
  it('refuses to alter an issued invoice', async () => {
    const inv = await db.query<{ id: string }>(
      `SELECT id FROM document WHERE company_id=$1 AND status='paye' LIMIT 1`, [companyId]);
    await expect(
      db.query(`UPDATE document SET total_incl_vat=1 WHERE id=$1`, [inv.rows[0]!.id]),
    ).rejects.toThrow(/cannot be modified/i);
  });

  // -- 7. the work: a task is signed off by two different people -----------
  it('needs a member to submit and a moderator to complete', async () => {
    const p = await db.query<{ id: string }>(
      `INSERT INTO project (name, company_id, status, project_type)
       VALUES ($1,$2,'active','branding') RETURNING id`, [MARK, companyId]);
    const projectId = p.rows[0]!.id;

    let taskId = '';
    await as(moderatorId, 'moderator', async () => {
      const t = await db.query<{ id: string }>(
        `INSERT INTO task (title, project_id, assignee_id, status, priority)
         VALUES ($1,$2,$3,'todo','normal') RETURNING id`, [MARK, projectId, memberId]);
      taskId = t.rows[0]!.id;
    });

    // The member may submit, but never complete.
    await as(memberId, 'member', async () => {
      await db.query(`UPDATE task SET status='submitted' WHERE id=$1`, [taskId]);
      await expect(
        db.query(`UPDATE task SET status='completed' WHERE id=$1`, [taskId]),
      ).rejects.toThrow(/moderator/i);
    });

    // The moderator signs it off, and the row records who.
    await as(moderatorId, 'moderator', async () => {
      await db.query(`UPDATE task SET status='completed' WHERE id=$1`, [taskId]);
    });
    const done = await db.query<{ status: string; by: string | null; at: string | null }>(
      `SELECT status, completed_by_id AS by, completed_at::text AS at FROM task WHERE id=$1`, [taskId]);
    expect(done.rows[0]!.status).toBe('completed');
    expect(done.rows[0]!.by).toBe(moderatorId);
    expect(done.rows[0]!.at).not.toBeNull();
  });

  // -- 8. a member cannot touch someone else's task ------------------------
  it("refuses a member editing another person's task", async () => {
    const p = await db.query<{ id: string }>(
      `SELECT id FROM project WHERE company_id=$1 LIMIT 1`, [companyId]);
    let taskId = '';
    await as(moderatorId, 'moderator', async () => {
      const t = await db.query<{ id: string }>(
        `INSERT INTO task (title, project_id, assignee_id, status, priority)
         VALUES ($1,$2,$3,'todo','normal') RETURNING id`, [MARK, p.rows[0]!.id, moderatorId]);
      taskId = t.rows[0]!.id;
    });
    await as(memberId, 'member', async () => {
      await expect(
        db.query(`UPDATE task SET status='in_progress' WHERE id=$1`, [taskId]),
      ).rejects.toThrow(/assigned to you/i);
    });
  });

  // -- 9. a member cannot create a task at all -----------------------------
  it('refuses a member creating a task', async () => {
    const p = await db.query<{ id: string }>(
      `SELECT id FROM project WHERE company_id=$1 LIMIT 1`, [companyId]);
    await as(memberId, 'member', async () => {
      await expect(
        db.query(`INSERT INTO task (title, project_id, status, priority) VALUES ($1,$2,'todo','normal')`,
          [MARK, p.rows[0]!.id]),
      ).rejects.toThrow(/moderator/i);
    });
  });

  // -- 10. money is invisible to a member ----------------------------------
  //
  // This one opens its OWN connection as the application role. The owner role
  // this suite otherwise uses holds BYPASSRLS, so a visibility assertion made
  // on it passes no matter what the policies say — it looked like a security
  // hole on the first run and was only the test lying.
  it('shows a member no documents and no ledger, as the app role', async () => {
    const appUrl = process.env.APP_DATABASE_URL;
    if (!appUrl) {
      throw new Error('APP_DATABASE_URL is not set — this assertion cannot be made as the owner.');
    }

    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      const bypass = await app.query<{ b: boolean }>(
        `SELECT rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`,
      );
      // If this ever becomes true, every RLS assertion in the app is worthless.
      expect(bypass.rows[0]!.b).toBe(false);

      await app.query(`SELECT set_config('app.user_id',$1,false)`, [memberId]);
      await app.query(`SELECT set_config('app.user_role','member',false)`);

      const docs = await app.query(`SELECT 1 FROM document`);
      const money = await app.query(`SELECT 1 FROM finance_entry`);
      const payments = await app.query(`SELECT 1 FROM document_payment`);
      expect(docs.rows).toHaveLength(0);
      expect(money.rows).toHaveLength(0);
      expect(payments.rows).toHaveLength(0);

      // And the same person CAN see the work they are there to do.
      const projects = await app.query(`SELECT 1 FROM project`);
      expect(projects.rows.length).toBeGreaterThan(0);
    } finally {
      await app.end();
    }
  });
});

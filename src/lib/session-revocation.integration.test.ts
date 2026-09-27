import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Turning an account off takes effect on the next request.
 *
 * From a source audit, and it was the same defect on both sides.
 *
 * Identity and role are established at sign-in and carried in a signed JWT for
 * twelve hours. Every request puts those claims into the transaction and every
 * policy trusts them — so `is_active` and `role` were read once, at the door, and
 * never again. Disabling somebody changed a row nothing downstream consulted.
 * A demoted administrator kept administrator access. A client whose account we
 * had deliberately turned off carried on reading that company's projects and its
 * support conversation.
 *
 * What made it invisible is that everything LOOKS right: the row says inactive,
 * the team page shows them as turned off, and they are still working.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const CLIENT = process.env.CLIENT_DATABASE_URL;
const MARK = 'ZZZ revocation probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP || !CLIENT) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('a session is not a promise (integration)', () => {
  let owner: Client;
  let portal: Pool;
  let company = '';
  let contact = '';

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_account WHERE contact_id IN
                        (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  /** The portal's own connection, in the shoes of one contact. */
  async function asClient<T>(work: (tx: never) => Promise<T>): Promise<T> {
    return drizzle(portal).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.client_contact_id', ${contact}, true)`);
      return work(tx as never);
    });
  }
  type Q = { execute: (q: unknown) => Promise<{ rows: Record<string, unknown>[] }> };

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    await owner.query("SET app.bootstrap = 'on'");

    const staff = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' AND is_active LIMIT 1`)).rows[0]!.id;

    company = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship)
       VALUES ($1,'client','client') RETURNING id`, [`${MARK} co`])).rows[0]!.id;
    contact = (await owner.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email)
       VALUES ($1,$2,'zzz-revocation@example.invalid') RETURNING id`,
      [company, `${MARK} person`])).rows[0]!.id;
    await owner.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',$2)`,
      [contact, staff]);
    await owner.query(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'active')`,
      [company, `${MARK} project`]);

    portal = new Pool({ connectionString: CLIENT, max: 2 });
  });

  afterAll(async () => {
    if (portal) await portal.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('shows an active client their own company', async () => {
    // The baseline. Without it the refusals below could be passing because the
    // fixture is wrong rather than because the rule works.
    const r = await asClient((tx) => (tx as unknown as Q).execute(sql`
      SELECT app.current_client_company()::text AS company
    `));
    expect(r.rows[0]!.company).toBe(company);

    const p = await asClient((tx) => (tx as unknown as Q).execute(sql`
      SELECT name FROM project WHERE company_id = ${company}
    `));
    expect(p.rows).toHaveLength(1);
  });

  it('cuts off a deactivated client on the next request', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`UPDATE client_account SET is_active = false WHERE contact_id = $1`, [contact]);

    const r = await asClient((tx) => (tx as unknown as Q).execute(sql`
      SELECT app.current_client_company()::text AS company
    `));
    expect(r.rows[0]!.company, 'a turned-off account still resolves its company').toBeNull();

    // And that is the whole boundary: every client policy is written in terms of
    // that function, so nothing is reachable once it returns NULL.
    const p = await asClient((tx) => (tx as unknown as Q).execute(sql`
      SELECT name FROM project WHERE company_id = ${company}
    `));
    expect(p.rows, 'a turned-off client can still read their projects').toHaveLength(0);
  });

  it('cuts off a client whose company has been archived', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`UPDATE client_account SET is_active = true WHERE contact_id = $1`, [contact]);
    await owner.query(`UPDATE company SET archived_at = now() WHERE id = $1`, [company]);

    const r = await asClient((tx) => (tx as unknown as Q).execute(sql`
      SELECT app.current_client_company()::text AS company
    `));
    expect(r.rows[0]!.company, 'the portal outlives the relationship').toBeNull();
  });

  it('lets them back in when both are restored', async () => {
    // The other direction: a rule that refused everybody would pass all three
    // tests above and lock every client out.
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`UPDATE company SET archived_at = NULL WHERE id = $1`, [company]);

    const r = await asClient((tx) => (tx as unknown as Q).execute(sql`
      SELECT app.current_client_company()::text AS company
    `));
    expect(r.rows[0]!.company).toBe(company);
  });

  it('records a client sign-in, which it never could before', async () => {
    /*
     * The old `app.record_client_sign_in()` read the session identity, and
     * sign-in is the one moment at which there is none — so it returned without
     * writing, every time, and the Client portal page said "never" about
     * accounts that had signed in.
     */
    await owner.query(`SELECT app.record_client_sign_in($1)`, [contact]);
    const { rows } = await owner.query<{ at: string | null }>(
      `SELECT last_sign_in_at::text AS at FROM client_account WHERE contact_id = $1`, [contact]);
    expect(rows[0]!.at, 'a client sign-in is still not recorded').not.toBeNull();
  });

  it('does not stamp a sign-in on a deactivated account', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `UPDATE client_account SET is_active = false, last_sign_in_at = NULL WHERE contact_id = $1`,
      [contact]);
    await owner.query(`SELECT app.record_client_sign_in($1)`, [contact]);
    const { rows } = await owner.query<{ at: string | null }>(
      `SELECT last_sign_in_at::text AS at FROM client_account WHERE contact_id = $1`, [contact]);
    expect(rows[0]!.at).toBeNull();
  });

  // --- the staff side, and the trust boundary --------------------------------

  it('re-reads the staff account inside every transaction', () => {
    /*
     * `withUser` is the single door every staff read and write goes through, so
     * the check belongs there rather than in pages — all of them, including the
     * ones written next year.
     */
    const source = readFileSync(join(process.cwd(), 'src/db/session.ts'), 'utf8');
    expect(source).toContain('SELECT role, is_active FROM app_user WHERE id =');
    expect(source, 'an inactive account is not refused').toMatch(/!account\.is_active/);
    // A demotion takes effect on this request, not the next sign-in.
    expect(source).toContain("set_config('app.user_role', ${account.role}");
    // And the client side gets a readable error rather than an empty portal.
    expect(source).toContain('app.current_client_company() IS NOT NULL');
  });

  it('never accepts a security flag from the caller', () => {
    /*
     * `jwt({ trigger: 'update' })` copied `session.mustChangePassword` straight
     * into the token — so somebody signed in on an initial password could clear
     * the gate that exists to stop them, from their own browser, without
     * changing anything. Two people are still on the shared starter password.
     */
    const source = readFileSync(join(process.cwd(), 'src/auth.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    expect(code, 'the session-update branch is back').not.toContain("trigger === 'update'");
    expect(code).not.toMatch(/claims\.mustChangePassword\s*=\s*update\./);
    // The flag still has to arrive from the database at sign-in.
    expect(code).toContain('claims.mustChangePassword = user.mustChangePassword');
  });
});

describe.skipIf(!HAS_DB)('dates a calendar can hold (integration)', () => {
  let db: Client;
  let company = '';
  const MARK2 = 'ZZZ date probe';

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await db.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK2}%`]);
    await db.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK2}%`]);
    company = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship)
       VALUES ($1,'client','client') RETURNING id`, [`${MARK2} co`])).rows[0]!.id;
  });

  afterAll(async () => {
    if (db) {
      await db.query("SET app.bootstrap = 'on'");
      await db.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK2}%`]);
      await db.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK2}%`]);
      await db.end();
    }
  });

  it('refuses a deadline in the year 87664', async () => {
    /*
     * A real record carried exactly this — `due_date 87664-09-09` and
     * `start_date 0753-04-04`, two typed dates both wrong. The cost is not the
     * display: everything that reasons about deadlines treated that project as
     * never due and never started, so it sat outside every warning the system
     * produces. Which is the opposite of what a deadline is for.
     */
    await expect(db.query(
      `INSERT INTO project (company_id, name, status, due_date)
       VALUES ($1,$2,'active','87664-09-09')`, [company, `${MARK2} far future`],
    )).rejects.toThrow(/project_dates_plausible|violates check/i);
  });

  it('refuses a start date in the year 753', async () => {
    await expect(db.query(
      `INSERT INTO project (company_id, name, status, start_date)
       VALUES ($1,$2,'active','0753-04-04')`, [company, `${MARK2} far past`],
    )).rejects.toThrow(/project_dates_plausible|violates check/i);
  });

  it('accepts the dates anybody would actually type', async () => {
    // The bound is about typing accidents, not about the business. Nothing
    // legitimate may be refused.
    await expect(db.query(
      `INSERT INTO project (company_id, name, status, start_date, due_date)
       VALUES ($1,$2,'active','2026-09-01','2031-12-31')`, [company, `${MARK2} ordinary`],
    )).resolves.toBeTruthy();
  });

  it('leaves no outlier in the data', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM project
        WHERE due_date   NOT BETWEEN '2000-01-01' AND '2100-01-01'
           OR start_date NOT BETWEEN '2000-01-01' AND '2100-01-01'`);
    expect(rows[0]!.n).toBe('0');
  });
});

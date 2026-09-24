import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { listPortalProjects } from './client-portal-queries';
import type { Tx } from '@/db/session';

/**
 * The figure a client reads, and who is allowed to move it.
 *
 * Progress was a count of completed tasks. Honest, and frequently wrong for
 * the reader: a project the team runs out of a shared document has no tasks at
 * all, so a client watching a film being made was shown a bar at zero or no bar
 * whatsoever. Amin asked for a number he and Mohamed Amine could set.
 *
 * That makes it the first thing in this system that is BOTH written by hand and
 * shown to somebody outside the company, so two rules matter more than the
 * feature does:
 *
 *   1. only management may move it — enforced by a trigger, so it holds for
 *      any page written later and not only for the action that exists today;
 *   2. an override wins where it is set and vanishes where it is cleared, with
 *      the decision made in ONE place. Computed in the portal and again on the
 *      internal page is how the two come to disagree, and the one that would be
 *      wrong is the one the client reads.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const CLIENT = process.env.CLIENT_DATABASE_URL;
const MARK = 'ZZZ progress probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP || !CLIENT) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('progress a person sets (integration)', () => {
  let owner: Client;
  let app: Pool;
  let portal: Pool;
  let staffId = '';
  let memberId = '';
  let company = '';
  let contact = '';
  /** Four tasks, one of them done — 25% by the count. */
  let counted = '';
  /** No tasks at all, which is the case the count could not describe. */
  let empty = '';

  async function asStaff<T>(role: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzle(app).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${role === 'member' ? memberId : staffId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_role', ${role}, true)`);
      return work(tx as unknown as Tx);
    });
  }

  async function asClient<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzle(portal).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.client_contact_id', ${contact}, true)`);
      return work(tx as unknown as Tx);
    });
  }

  async function percentFor(projectId: string): Promise<{ percent: number; by_hand: boolean; done: number; total: number }> {
    const r = await asStaff('moderator', (tx) =>
      tx.execute<{ percent: number; by_hand: boolean; done: number; total: number }>(
        sql`SELECT * FROM app.project_progress(${projectId})`));
    return r.rows[0]!;
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM notification WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM task WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_account WHERE contact_id IN
                        (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    await owner.query("SET app.bootstrap = 'on'");

    const people = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 2`);
    staffId = people.rows[0]!.id;
    memberId = people.rows[1]?.id ?? staffId;

    company = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship)
       VALUES ($1,'client','client') RETURNING id`, [`${MARK} co`])).rows[0]!.id;
    contact = (await owner.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email)
       VALUES ($1,$2,'zzz-progress@example.invalid') RETURNING id`,
      [company, `${MARK} person`])).rows[0]!.id;
    await owner.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',$2)`,
      [contact, staffId]);

    counted = (await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
      [company, `${MARK} counted`])).rows[0]!.id;
    empty = (await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
      [company, `${MARK} empty`])).rows[0]!.id;

    // Created as todo and then completed: a trigger refuses a task inserted
    // already done, because completion is a sign-off on work that exists.
    for (let i = 1; i <= 4; i += 1) {
      await owner.query(
        `INSERT INTO task (project_id, title, status, priority, assignee_id, created_by_id)
         VALUES ($1,$2,'todo','normal',$3,$3)`,
        [counted, `${MARK} step ${i}`, staffId]);
    }
    await owner.query(
      `UPDATE task SET status='completed', completed_by_id=$2, completed_at=now()
        WHERE project_id=$1 AND title=$3`,
      [counted, staffId, `${MARK} step 1`]);

    app = new Pool({ connectionString: APP, max: 2 });
    portal = new Pool({ connectionString: CLIENT, max: 2 });
  });

  afterAll(async () => {
    if (app) await app.end();
    if (portal) await portal.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('counts tasks when nobody has set a figure', async () => {
    const p = await percentFor(counted);
    expect(p.done).toBe(1);
    expect(p.total).toBe(4);
    expect(p.percent).toBe(25);
    expect(p.by_hand).toBe(false);
  });

  it('says zero, not nonsense, for a project with no tasks', async () => {
    const p = await percentFor(empty);
    expect(p.total).toBe(0);
    expect(p.percent).toBe(0);
  });

  it('changes nothing when a member tries to move it', async () => {
    /*
     * A member gets no error and no effect, which is worth being precise about
     * because I first wrote this test expecting the trigger to raise.
     *
     * It does not, and the reason is that `project_update` was ALREADY
     * `app.is_moderator()` — the whole table has been management-only for
     * writes since 0006, so RLS hides the row and the UPDATE matches nothing
     * before any trigger runs. Amin's "only me and Mohamed Amine" was already
     * true for projects; what was missing was the column, not the rule.
     *
     * The trigger is therefore the SECOND lock, and it is not decoration: it is
     * what still holds if `project_update` is ever widened to let members edit
     * a project's dates — a change somebody will reasonably want, and one that
     * would otherwise quietly hand them the figure a client reads. It also
     * stamps who moved it, which is the part exercised below.
     */
    const before = await percentFor(counted);

    const attempt = await asStaff('member', (tx) =>
      tx.execute(sql`UPDATE project SET progress_override = 90 WHERE id = ${counted}`));
    expect(attempt.rowCount ?? 0).toBe(0);

    const after = await percentFor(counted);
    expect(after.percent).toBe(before.percent);
    expect(after.by_hand).toBe(before.by_hand);
  });

  it('keeps the second lock attached', async () => {
    // The trigger is unreachable while the policy refuses first, so nothing
    // would fail if it were dropped — until the day the policy changes. Checked
    // by name for that reason.
    const r = await owner.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'project'::regclass AND NOT tgisinternal
          AND tgname = 'project_progress_is_management'`);
    expect(r.rowCount, 'the management check on progress_override is gone').toBe(1);
  });

  it('lets a moderator move it, and shows that instead of the count', async () => {
    await asStaff('moderator', (tx) =>
      tx.execute(sql`UPDATE project SET progress_override = 70 WHERE id = ${counted}`));

    const p = await percentFor(counted);
    expect(p.percent).toBe(70);
    expect(p.by_hand).toBe(true);
    // The count is not destroyed by setting a figure — it stays visible, so a
    // hand-set number that has drifted is something somebody can see.
    expect(p.done).toBe(1);
    expect(p.total).toBe(4);
  });

  it('records who moved it, without being told', async () => {
    const r = await owner.query<{ by: string | null; at: string | null }>(
      `SELECT progress_set_by_id AS by, progress_set_at::text AS at
         FROM project WHERE id = $1`, [counted]);
    expect(r.rows[0]!.by).toBe(staffId);
    expect(r.rows[0]!.at).not.toBeNull();
  });

  it('shows the client the figure that was set', async () => {
    const projects = await asClient((tx) => listPortalProjects(tx));
    const seen = projects.find((p) => p.name === `${MARK} counted`);
    expect(seen, 'the client cannot see their own project').toBeDefined();
    expect(Number(seen!.percent)).toBe(70);
  });

  it('gives a project with no tasks a figure it could not have had', async () => {
    await asStaff('admin', (tx) =>
      tx.execute(sql`UPDATE project SET progress_override = 40 WHERE id = ${empty}`));
    const projects = await asClient((tx) => listPortalProjects(tx));
    const seen = projects.find((p) => p.name === `${MARK} empty`);
    expect(Number(seen!.percent)).toBe(40);
  });

  it('stops showing the step count once a figure is set by hand', async () => {
    /*
     * Found on the running page, not in a test: the client's card printed a
     * hand-set 70% directly above "1 of 2 steps done". Any reader divides one
     * by two, gets 50, and concludes that one of the two numbers is untrue.
     *
     * The card now hides the step count when the bar is not the step count, and
     * `by_hand` is what it reads to know. So the query must carry it.
     */
    const projects = await asClient((tx) => listPortalProjects(tx));
    const seen = projects.find((p) => p.name === `${MARK} counted`);
    expect(seen!.by_hand, 'the portal cannot tell a set figure from a counted one').toBe(true);
    expect(Number(seen!.percent)).toBe(70);

    const untouched = projects.find((p) => p.name === `${MARK} empty`);
    // That one was also set by hand in the test above.
    expect(untouched!.by_hand).toBe(true);
  });

  it('goes back to the count when it is cleared', async () => {
    await asStaff('moderator', (tx) =>
      tx.execute(sql`UPDATE project SET progress_override = NULL WHERE id = ${counted}`));
    const p = await percentFor(counted);
    expect(p.percent).toBe(25);
    expect(p.by_hand).toBe(false);
  });

  it('says the figure is counted again once it is cleared', async () => {
    const projects = await asClient((tx) => listPortalProjects(tx));
    const seen = projects.find((p) => p.name === `${MARK} counted`);
    expect(seen!.by_hand).toBe(false);
    expect(Number(seen!.percent)).toBe(25);
  });

  it('refuses a figure that is not a percentage', async () => {
    for (const bad of [101, -1, 1000]) {
      await expect(
        asStaff('admin', (tx) =>
          tx.execute(sql`UPDATE project SET progress_override = ${bad} WHERE id = ${counted}`)),
      ).rejects.toThrow();
    }
  });

  it('still refuses to tell a client about somebody else’s project', async () => {
    // `app.project_progress` is SECURITY DEFINER and takes an id, which is a
    // way to ask about rows you were never shown unless it is guarded.
    const other = (await owner.query<{ id: string }>(
      `SELECT p.id FROM project p JOIN company c ON c.id = p.company_id
        WHERE p.company_id <> $1 LIMIT 1`, [company])).rows[0];

    if (!other) return; // No second company on this database; nothing to prove.

    const r = await asClient((tx) =>
      tx.execute<{ percent: number; total: number }>(
        sql`SELECT * FROM app.project_progress(${other.id})`));
    // Zeros rather than an error: a refusal that looks different from an empty
    // project is itself an answer about a project you may not see.
    expect(r.rows[0]!.percent).toBe(0);
    expect(r.rows[0]!.total).toBe(0);
  });
});

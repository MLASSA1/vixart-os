import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

/**
 * A member sees their own work, and signs it off themselves.
 *
 * Amin asked for three things at once and they are one decision: each task is
 * the business of the person doing it, three buttons move it, and management is
 * TOLD when something is finished rather than asked for permission.
 *
 * Each has a way to go wrong that is invisible from the screen:
 *
 *   * a visibility rule that is too tight hides the task you raised for somebody
 *     else, so you cannot follow up on your own request;
 *   * one that is too loose changes nothing and the team still reads each
 *     other's work;
 *   * `app.project_progress()` counting tasks through the CALLER's policies
 *     would silently drop every client's progress bar to zero for six of eight
 *     people — the bar would still draw, at 0%, on the page a client reads;
 *   * and letting a member pass `completed_by_id` would let them sign off as
 *     somebody else.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ own work probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('your own work (integration)', () => {
  let owner: Client;
  let app: Pool;
  let mine = '';
  let theirs = '';
  let boss = '';
  let company = '';
  let project = '';

  /** A task assigned to me, one to them, and one I raised for them. */
  const task = { mine: '', theirs: '', iRaised: '' };

  type Q = {
    execute: (q: unknown) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  };

  async function as<T>(id: string, role: string, work: (q: Q) => Promise<T>): Promise<T> {
    return drizzle(app).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${id}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_role', ${role}, true)`);
      return work(tx as unknown as Q);
    });
  }

  async function refused(run: () => Promise<unknown>, because: RegExp): Promise<void> {
    let thrown: unknown;
    try { await run(); } catch (e) { thrown = e; }
    expect(thrown, 'the statement was allowed').toBeDefined();
    const chain: string[] = [];
    let cur: unknown = thrown;
    for (let i = 0; cur && i < 5; i += 1) {
      const e = cur as { message?: string; cause?: unknown; detail?: string };
      if (e.message) chain.push(e.message);
      if (e.detail) chain.push(e.detail);
      cur = e.cause;
    }
    expect(chain.join(' | '), `refused, but not by ${because}`).toMatch(because);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM notification WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM task WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    await owner.query("SET app.bootstrap = 'on'");

    const people = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'member' AND is_active
         AND is_assignable AND NOT is_service_account ORDER BY created_at LIMIT 2`)).rows;
    mine = people[0]!.id;
    theirs = people[1]!.id;
    boss = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role IN ('admin','moderator') AND is_active
        ORDER BY created_at LIMIT 1`)).rows[0]!.id;

    company = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship)
       VALUES ($1,'client','client') RETURNING id`, [`${MARK} co`])).rows[0]!.id;
    project = (await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status)
       VALUES ($1,$2,'active') RETURNING id`, [company, `${MARK} project`])).rows[0]!.id;

    const make = async (title: string, assignee: string, raisedBy: string) =>
      (await owner.query<{ id: string }>(
        `INSERT INTO task (project_id, title, status, priority, assignee_id, created_by_id)
         VALUES ($1,$2,'todo','normal',$3,$4) RETURNING id`,
        [project, `${MARK} ${title}`, assignee, raisedBy])).rows[0]!.id;

    task.mine = await make('assigned to me', mine, boss);
    task.theirs = await make('assigned to them', theirs, boss);
    task.iRaised = await make('I asked them for this', theirs, mine);

    app = new Pool({ connectionString: APP, max: 3 });
  });

  afterAll(async () => {
    if (app) await app.end();
    if (owner) { await purge(); await owner.end(); }
  });

  // --- who can see what -------------------------------------------------------

  it('shows a member their own task', async () => {
    const r = await as(mine, 'member', (q) => q.execute(sql`
      SELECT id FROM task WHERE id = ${task.mine}
    `));
    expect(r.rows).toHaveLength(1);
  });

  it('hides a colleague’s task', async () => {
    const r = await as(mine, 'member', (q) => q.execute(sql`
      SELECT id FROM task WHERE id = ${task.theirs}
    `));
    expect(r.rows, 'a member can still read a colleague’s task').toHaveLength(0);
  });

  it('keeps showing a member what they raised for somebody else', async () => {
    /*
     * The half that is easy to get wrong by being too strict. Somebody who asks
     * a colleague for something has a stake in it — the blocked notification
     * already goes to whoever raised a task — and losing sight of your own
     * request is not privacy, it is amnesia.
     */
    const r = await as(mine, 'member', (q) => q.execute(sql`
      SELECT id FROM task WHERE id = ${task.iRaised}
    `));
    expect(r.rows, 'a member lost the task they raised').toHaveLength(1);
  });

  it('shows management everything', async () => {
    const r = await as(boss, 'moderator', (q) => q.execute(sql`
      SELECT id FROM task WHERE title LIKE ${`${MARK}%`}
    `));
    expect(r.rows).toHaveLength(3);
  });

  it('still counts every task for a client’s progress bar', async () => {
    /*
     * THE ONE THAT WOULD HAVE BEEN SILENT.
     *
     * `app.project_progress()` is SECURITY DEFINER and counts inside the
     * database, so it is unaffected by who is asking. Had it read `task`
     * through the caller's policies, this change would have dropped every
     * client's progress to zero for six of the eight people here — and the bar
     * would still have drawn, at 0%, on the page the client reads.
     */
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `UPDATE task SET status='completed', completed_by_id=$2, completed_at=now()
        WHERE id = $1`, [task.theirs, boss]);

    const seen = await as(mine, 'member', (q) => q.execute(sql`
      SELECT done, total FROM app.project_progress(${project})
    `));
    // Three tasks on the project, one finished — and this member can only SEE
    // two of them.
    expect(Number(seen.rows[0]!.total), 'progress now counts only what the reader can see').toBe(3);
    expect(Number(seen.rows[0]!.done)).toBe(1);

    await owner.query(
      `UPDATE task SET status='todo', completed_by_id=NULL, completed_at=NULL
        WHERE id = $1`, [task.theirs]);
  });

  // --- the three buttons ------------------------------------------------------

  it('lets a member accept and start their own task', async () => {
    for (const status of ['accepted', 'in_progress']) {
      const r = await as(mine, 'member', (q) => q.execute(sql`
        UPDATE task SET status = ${status} WHERE id = ${task.mine}
      `));
      expect(r.rowCount, status).toBe(1);
    }
  });

  it('lets a member mark their own task finished, which it refused before', async () => {
    const r = await as(mine, 'member', (q) => q.execute(sql`
      UPDATE task SET status = 'completed' WHERE id = ${task.mine}
    `));
    expect(r.rowCount).toBe(1);

    const { rows } = await owner.query<{ by: string | null; at: string | null }>(
      `SELECT completed_by_id AS by, completed_at::text AS at FROM task WHERE id = $1`,
      [task.mine]);
    // Stamped with their own id by the trigger, so the record is no weaker than
    // it was under sign-off — it is the permission that moved.
    expect(rows[0]!.by).toBe(mine);
    expect(rows[0]!.at).not.toBeNull();
  });

  it('will not let a member sign off as somebody else', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`UPDATE task SET status='todo', completed_at=NULL, completed_by_id=NULL
                        WHERE id=$1`, [task.mine]);

    await as(mine, 'member', (q) => q.execute(sql`
      UPDATE task SET status = 'completed', completed_by_id = ${boss} WHERE id = ${task.mine}
    `));
    const { rows } = await owner.query<{ by: string }>(
      `SELECT completed_by_id AS by FROM task WHERE id = $1`, [task.mine]);
    expect(rows[0]!.by, 'a member signed a task off in somebody else’s name').toBe(mine);
  });

  it('lets a member reopen their own task, and clears the stamp', async () => {
    // With three buttons this is the only way to undo a mis-click.
    const r = await as(mine, 'member', (q) => q.execute(sql`
      UPDATE task SET status = 'in_progress' WHERE id = ${task.mine}
    `));
    expect(r.rowCount).toBe(1);

    const { rows } = await owner.query<{ by: string | null; at: string | null }>(
      `SELECT completed_by_id AS by, completed_at::text AS at FROM task WHERE id = $1`,
      [task.mine]);
    expect(rows[0]!.by).toBeNull();
    expect(rows[0]!.at).toBeNull();
  });

  it('still refuses a member rewriting what the task IS', async () => {
    // The half of the old rule that was never about sign-off, and is unchanged.
    await refused(
      () => as(mine, 'member', (q) => q.execute(sql`
        UPDATE task SET title = 'renamed by the assignee' WHERE id = ${task.mine}
      `)),
      /not its definition/i,
    );
    await refused(
      () => as(mine, 'member', (q) => q.execute(sql`
        UPDATE task SET due_date = current_date + 90 WHERE id = ${task.mine}
      `)),
      /not its definition/i,
    );
  });

  it('still refuses a member touching a colleague’s task', async () => {
    const r = await as(mine, 'member', (q) => q.execute(sql`
      UPDATE task SET status = 'completed' WHERE id = ${task.theirs}
    `));
    // Not an error: the row is not theirs to see, so the UPDATE matches nothing.
    expect(r.rowCount, 'a member moved a colleague’s task').toBe(0);
  });

  // --- somebody finished something -------------------------------------------

  it('tells whoever raised it, and management', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM notification WHERE entity_id = $1`, [task.iRaised]);

    // `theirs` finishes the task that `mine` raised for them.
    await as(theirs, 'member', (q) => q.execute(sql`
      UPDATE task SET status = 'completed' WHERE id = ${task.iRaised}
    `));

    const told = (await owner.query<{ recipient_id: string; body: string }>(
      `SELECT recipient_id, body FROM notification
        WHERE kind = 'task_completed' AND entity_id = $1`, [task.iRaised])).rows;

    const recipients = told.map((t) => t.recipient_id);
    expect(recipients, 'the person who raised it was not told').toContain(mine);
    expect(recipients, 'management was not told').toContain(boss);
    expect(recipients, 'the person who did it was told about their own work')
      .not.toContain(theirs);
    expect(told[0]!.body, 'the notification does not say who finished it').toMatch(/finished it/);
  });

  it('does not send a second notification when it is finished twice', async () => {
    /*
     * A member reopening a mis-click and finishing again is one piece of news,
     * not two. `notification_one_per_state` covers task_completed, so Amin gets
     * one email about one task however many times the button is pressed.
     */
    const before = (await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification
        WHERE kind='task_completed' AND entity_id=$1`, [task.iRaised])).rows[0]!.n;

    await as(theirs, 'member', (q) => q.execute(sql`
      UPDATE task SET status = 'in_progress' WHERE id = ${task.iRaised}
    `));
    await as(theirs, 'member', (q) => q.execute(sql`
      UPDATE task SET status = 'completed' WHERE id = ${task.iRaised}
    `));

    const after = (await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification
        WHERE kind='task_completed' AND entity_id=$1`, [task.iRaised])).rows[0]!.n;
    expect(after, 'a re-completion sent another round of notifications').toBe(before);
  });
});

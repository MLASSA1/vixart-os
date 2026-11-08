import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The completion notice, and what happens when a task is reopened.
 *
 * `notification_one_per_state` (0075) keeps one `task_completed` row per person
 * per task, so that a member correcting a mis-click does not mail Amin three
 * times. `app.notify` inserts ON CONFLICT DO NOTHING, which made that stricter
 * than intended: the FIRST completion was the only one that ever existed. A
 * task reopened and finished by somebody else produced no new row, and the
 * inbox kept a notice naming the wrong person and the wrong day — worse than no
 * notice, because it is specific.
 *
 * 0077 wrote `app.notify_retract` to withdraw the notice when a task leaves
 * `completed`, and 0078 actually applied it: the retraction sat in 0077 after
 * 0077 had already run, so it existed in no database and nothing failed. There
 * was no test. That is why there is one now.
 *
 * Everything below runs as `vixart_app` with a real identity, because the owner
 * role is a superuser and bypasses every policy — a completion that "works" as
 * owner proves nothing about whether a member can do it.
 */

const URL = process.env.DATABASE_URL;
const MARK = 'ZZZ completion notice probe';

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('task completion notices (integration)', () => {
  let db: Client;
  let admin = '';
  let moderator = '';
  let first = '';
  let second = '';

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    const pick = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0]!.id;
    admin = await pick(`SELECT id FROM app_user WHERE role='admin' LIMIT 1`);
    moderator = await pick(`SELECT id FROM app_user WHERE role='moderator' LIMIT 1`);
    first = await pick(
      `SELECT id FROM app_user WHERE role='member' AND is_assignable
         AND NOT is_service_account ORDER BY full_name LIMIT 1`);
    second = await pick(
      `SELECT id FROM app_user WHERE role='member' AND is_assignable
         AND NOT is_service_account ORDER BY full_name DESC LIMIT 1`);
    expect(first).not.toBe(second);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`SET app.bootstrap = 'on'`);
      await db.query(
        `DELETE FROM notification WHERE entity_id IN (SELECT id FROM task WHERE title = $1)`, [MARK]);
      await db.query(`DELETE FROM task WHERE title = $1`, [MARK]);
      await db.end();
    }
  });

  /** Acts as somebody, on the application's own role, under its own policies. */
  async function as(userId: string, role: string, sql: string, params: unknown[] = []) {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE vixart_app');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      await db.query(`SELECT set_config('app.user_role', $1, true)`, [role]);
      const out = await db.query(sql, params);
      await db.query('COMMIT');
      return out;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }

  /** Who currently holds a completion notice for the probe task, and what it says. */
  async function notices(): Promise<string[]> {
    const { rows } = await db.query<{ line: string }>(
      `SELECT u.full_name || ': ' || n.body AS line
         FROM notification n JOIN app_user u ON u.id = n.recipient_id
        WHERE n.kind = 'task_completed'
          AND n.entity_id = (SELECT id FROM task WHERE title = $1)
        ORDER BY 1`, [MARK]);
    return rows.map((r) => r.line);
  }

  it('tells management who finished it, and not the person who did', async () => {
    await as(admin, 'admin',
      `INSERT INTO task (title, status, assignee_id, created_by_id) VALUES ($1,'in_progress',$2,$3)`,
      [MARK, first, admin]);

    await as(first, 'member', `UPDATE task SET status='completed' WHERE title=$1`, [MARK]);

    const told = await notices();
    // Both managers, named for the member who did the work. `app.notify`
    // refuses to tell anybody about their own action, so the member is absent.
    expect(told).toHaveLength(2);
    expect(told.every((t) => t.includes('finished it'))).toBe(true);
    expect(told.some((t) => t.startsWith('Amin:'))).toBe(true);
  });

  it('withdraws the notice when the task is reopened', async () => {
    await as(moderator, 'moderator', `UPDATE task SET status='in_progress' WHERE title=$1`, [MARK]);
    // Not "stale but harmless": while this row exists, one_per_state refuses the
    // next one, so leaving it would silently swallow the real completion.
    expect(await notices()).toEqual([]);
  });

  it('names the second finisher, not the first, after a reopen', async () => {
    await as(moderator, 'moderator', `UPDATE task SET assignee_id=$2 WHERE title=$1`, [MARK, second]);
    await as(second, 'member', `UPDATE task SET status='completed' WHERE title=$1`, [MARK]);

    const told = await notices();
    const secondName = (await db.query<{ full_name: string }>(
      `SELECT full_name FROM app_user WHERE id=$1`, [second])).rows[0]!.full_name;
    const firstName = (await db.query<{ full_name: string }>(
      `SELECT full_name FROM app_user WHERE id=$1`, [first])).rows[0]!.full_name;

    expect(told).toHaveLength(2);
    expect(told.every((t) => t.includes(secondName))).toBe(true);
    expect(told.some((t) => t.includes(firstName))).toBe(false);
  });

  it('links a member to a page they can open, and management to the project', async () => {
    // A member raises a task on a project and is sent /tasks, because /projects
    // bounces them; management gets the project itself.
    const project = (await db.query<{ id: string }>(`SELECT id FROM project LIMIT 1`)).rows[0];
    if (!project) return;

    const title = `${MARK} linked`;
    await as(first, 'member',
      `INSERT INTO task (title, status, assignee_id, created_by_id, project_id)
       VALUES ($1,'in_progress',$2,$3,$4)`, [title, second, first, project.id]);
    await as(second, 'member', `UPDATE task SET status='completed' WHERE title=$1`, [title]);

    const { rows } = await db.query<{ role: string; link: string }>(
      `SELECT u.role, n.link FROM notification n JOIN app_user u ON u.id = n.recipient_id
        WHERE n.kind='task_completed' AND n.entity_id=(SELECT id FROM task WHERE title=$1)`, [title]);

    for (const r of rows) {
      if (r.role === 'member') expect(r.link).toBe('/tasks');
      else expect(r.link).toBe(`/projects/${project.id}`);
    }
    expect(rows.some((r) => r.role === 'member' && r.link === '/tasks')).toBe(true);

    await db.query(`SET app.bootstrap = 'on'`);
    await db.query(
      `DELETE FROM notification WHERE entity_id IN (SELECT id FROM task WHERE title=$1)`, [title]);
    await db.query(`DELETE FROM task WHERE title=$1`, [title]);
  });
});

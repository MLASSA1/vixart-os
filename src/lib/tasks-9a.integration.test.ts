import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Phase 9A — a task the team can drive.
 *
 * Almost everything about tasks already existed and had never been used, so
 * these cover only what 9A changed: who may raise one, what the assignee can
 * say about it, that a block reaches the person waiting, and that sub-tasks
 * stop at one level.
 *
 * Every assertion is made through the APPLICATION role. The owner holds
 * BYPASSRLS, so the same assertion on it would pass whatever the policies say.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ 9A probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('tasks the team drives (9A)', () => {
  let owner: Client;
  let app: Client;
  let projectId = '';
  let editor = '';        // raises work on somebody else
  let designer = '';      // the one it lands on
  let boss = '';          // signs off

  async function actAs(id: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [id]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM notification WHERE entity_type='task' AND entity_id IN
                        (SELECT id FROM task WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM task WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();

    const people = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='member' AND is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 2`);
    editor = people.rows[0]!.id;
    designer = people.rows[1]!.id;
    boss = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role IN ('admin','moderator') AND is_active
        ORDER BY created_at LIMIT 1`)).rows[0]!.id;

    const co = await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [`${MARK} co`]);
    const pr = await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
      [co.rows[0]!.id, `${MARK} project`]);
    projectId = pr.rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  async function raise(byId: string, title: string, assignee: string | null, parent?: string) {
    await actAs(byId, 'member');
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, parent_id, status, priority)
       VALUES ($1,$2,$3,$4,'todo','normal') RETURNING id`,
      [title, projectId, assignee, parent ?? null]);
    return rows[0]!.id;
  }

  // --- who may raise one ---------------------------------------------------

  it('lets a member raise a task on another member', async () => {
    // The case the phase exists for: the editor needs a photo from the designer.
    const id = await raise(editor, `${MARK} needs a photo`, designer);

    const { rows } = await app.query<{ created_by_id: string; assignee_id: string }>(
      `SELECT created_by_id, assignee_id FROM task WHERE id=$1`, [id]);
    expect(rows[0]!.created_by_id).toBe(editor);
    expect(rows[0]!.assignee_id).toBe(designer);

    // And it reached them.
    const { rows: n } = await owner.query<{ kind: string }>(
      `SELECT kind FROM notification WHERE entity_id=$1 AND recipient_id=$2`, [id, designer]);
    expect(n.map((r) => r.kind)).toContain('task_assigned');
  });

  it('takes who raised it from the session, not the insert', async () => {
    await actAs(editor, 'member');
    const { rows } = await app.query<{ created_by_id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, created_by_id, status, priority)
       VALUES ($1,$2,$3,$4,'todo','normal') RETURNING created_by_id`,
      [`${MARK} forged author`, projectId, editor, designer]);
    expect(rows[0]!.created_by_id).toBe(editor);
  });

  // --- sign-off is untouched -----------------------------------------------

  it('still refuses a member signing off their own work', async () => {
    const id = await raise(designer, `${MARK} my own work`, designer);
    await actAs(designer, 'member');
    await expect(
      app.query(`UPDATE task SET status='completed' WHERE id=$1`, [id]),
    ).rejects.toThrow(/only a moderator/i);
  });

  it('still refuses a member touching somebody else\'s task', async () => {
    const id = await raise(editor, `${MARK} not yours`, designer);
    await actAs(editor, 'member');
    await expect(
      app.query(`UPDATE task SET status='accepted' WHERE id=$1`, [id]),
    ).rejects.toThrow(/only update a task assigned to you/i);
  });

  // --- the assignee answers for it -----------------------------------------

  it('lets the assignee move through the new states', async () => {
    const id = await raise(editor, `${MARK} states`, designer);
    await actAs(designer, 'member');
    for (const s of ['accepted', 'in_progress', 'submitted']) {
      await app.query(`UPDATE task SET status=$2 WHERE id=$1`, [id, s]);
      const { rows } = await app.query<{ status: string }>(
        `SELECT status FROM task WHERE id=$1`, [id]);
      expect(rows[0]!.status).toBe(s);
    }
  });

  it('refuses blocked without a reason', async () => {
    const id = await raise(editor, `${MARK} silent block`, designer);
    await actAs(designer, 'member');
    await expect(
      app.query(`UPDATE task SET status='blocked' WHERE id=$1`, [id]),
    ).rejects.toThrow(/task_blocked_needs_reason/);
  });

  it('notifies whoever raised it when the assignee blocks', async () => {
    const id = await raise(editor, `${MARK} blocked`, designer);
    await actAs(designer, 'member');
    await app.query(
      `UPDATE task SET status='blocked', blocked_reason=$2 WHERE id=$1`,
      [id, 'Waiting on the client to send the logo']);

    const { rows } = await owner.query<{ kind: string; body: string; recipient_id: string }>(
      `SELECT kind, body, recipient_id FROM notification
        WHERE entity_id=$1 AND kind='task_blocked'`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient_id).toBe(editor);
    expect(rows[0]!.body).toContain('Waiting on the client');
  });

  it('clears the reason when the task stops being blocked', async () => {
    const id = await raise(editor, `${MARK} unblocked`, designer);
    await actAs(designer, 'member');
    await app.query(`UPDATE task SET status='blocked', blocked_reason=$2 WHERE id=$1`,
      [id, 'Waiting on the brief']);
    await app.query(`UPDATE task SET status='in_progress' WHERE id=$1`, [id]);
    const { rows } = await app.query<{ blocked_reason: string | null }>(
      `SELECT blocked_reason FROM task WHERE id=$1`, [id]);
    expect(rows[0]!.blocked_reason).toBeNull();
  });

  // --- sub-tasks, one level ------------------------------------------------

  it('allows one level of sub-task', async () => {
    const parent = await raise(editor, `${MARK} parent`, designer);
    const child = await raise(editor, `${MARK} child`, designer, parent);
    const { rows } = await app.query<{ parent_id: string }>(
      `SELECT parent_id FROM task WHERE id=$1`, [child]);
    expect(rows[0]!.parent_id).toBe(parent);
  });

  it('refuses a second level', async () => {
    const parent = await raise(editor, `${MARK} p2`, designer);
    const child = await raise(editor, `${MARK} c2`, designer, parent);
    await expect(
      raise(editor, `${MARK} grandchild`, designer, child),
    ).rejects.toThrow(/one level deep/i);
  });

  it('refuses turning a parent into a child', async () => {
    const parent = await raise(editor, `${MARK} p3`, designer);
    await raise(editor, `${MARK} c3`, designer, parent);
    const other = await raise(editor, `${MARK} other`, designer);
    await actAs(boss, 'moderator');
    await expect(
      app.query(`UPDATE task SET parent_id=$2 WHERE id=$1`, [parent, other]),
    ).rejects.toThrow(/sub-tasks of its own/i);
  });

  it('refuses a member re-parenting their own task', async () => {
    // Moving work under a different parent changes what the work IS.
    const a = await raise(editor, `${MARK} p4`, designer);
    const b = await raise(editor, `${MARK} c4`, designer);
    await actAs(designer, 'member');
    await expect(
      app.query(`UPDATE task SET parent_id=$2 WHERE id=$1`, [b, a]),
    ).rejects.toThrow(/not its definition/i);
  });

  // --- closing a parent with open children ---------------------------------

  it('counts the open children of a parent', async () => {
    // The number the warning shows. If this query is wrong the interface warns
    // about the wrong thing, or — worse — silently never warns at all.
    const parent = await raise(editor, `${MARK} p5`, designer);
    await raise(editor, `${MARK} c5a`, designer, parent);
    const second = await raise(editor, `${MARK} c5b`, designer, parent);

    await actAs(boss, 'moderator');
    const open = async () =>
      (await app.query<{ n: number }>(
        `SELECT (SELECT count(*)::int FROM task c
                  WHERE c.parent_id = t.id AND c.status <> 'completed') AS n
           FROM task t WHERE t.id = $1`, [parent])).rows[0]!.n;

    expect(await open()).toBe(2);
    await app.query(`UPDATE task SET status='completed' WHERE id=$1`, [second]);
    expect(await open()).toBe(1);
  });

  it('allows closing a parent while children are open — warns, does not block', async () => {
    // Deliberate. A hard block would have people deleting sub-tasks to get
    // past it, which loses the record of what was dropped. The interface asks
    // once and names the number; the database does not stand in the way.
    const parent = await raise(editor, `${MARK} p6`, designer);
    await raise(editor, `${MARK} c6`, designer, parent);

    await actAs(boss, 'moderator');
    await app.query(`UPDATE task SET status='completed' WHERE id=$1`, [parent]);

    const { rows } = await app.query<{ status: string }>(
      `SELECT status FROM task WHERE id=$1`, [parent]);
    expect(rows[0]!.status).toBe('completed');

    // And the child is untouched — closing a parent is not a cascade.
    const { rows: child } = await app.query<{ status: string }>(
      `SELECT status FROM task WHERE parent_id=$1`, [parent]);
    expect(child[0]!.status).not.toBe('completed');
  });


  // --- work that is not a project ------------------------------------------

  it('lets a member raise a task with no project at all', async () => {
    // Fixing the studio lighting is work. Forcing it under a client
    // engagement either invents a fake project or means it is never written
    // down, which is what happened before 0055.
    await actAs(editor, 'member');
    const { rows } = await app.query<{ id: string; project_id: string | null }>(
      `INSERT INTO task (title, project_id, assignee_id, status, priority)
       VALUES ($1, NULL, $2, 'todo', 'normal') RETURNING id, project_id`,
      [`${MARK} fix the studio light`, designer]);
    expect(rows[0]!.project_id).toBeNull();

    // And it still notifies, because that path never depended on a project.
    const { rows: n } = await owner.query<{ kind: string }>(
      `SELECT kind FROM notification WHERE entity_id=$1`, [rows[0]!.id]);
    expect(n.map((r) => r.kind)).toContain('task_assigned');
  });

  it('does not notify somebody about work they raised for themselves', async () => {
    // app.notify refuses to tell a person about their own action, so a task
    // you give yourself is silent. Worth pinning: it looks like a missing
    // notification until you know it is deliberate.
    await actAs(editor, 'member');
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, status, priority)
       VALUES ($1, NULL, $2, 'todo', 'normal') RETURNING id`,
      [`${MARK} note to self`, editor]);
    const { rows: n } = await owner.query(
      `SELECT 1 FROM notification WHERE entity_id=$1`, [rows[0]!.id]);
    expect(n).toHaveLength(0);
  });

  it('keeps a sub-task in the same place as its parent', async () => {
    // One piece of work cannot be half internal and half on a client project:
    // every list that groups by project would disagree with itself.
    const parent = await raise(editor, `${MARK} p7`, designer);
    await actAs(editor, 'member');
    await expect(
      app.query(
        `INSERT INTO task (title, project_id, assignee_id, parent_id, status, priority)
         VALUES ($1, NULL, $2, $3, 'todo', 'normal')`,
        [`${MARK} orphaned child`, designer, parent]),
    ).rejects.toThrow(/same project as its parent/i);
  });

  it('allows an internal parent with an internal child', async () => {
    await actAs(editor, 'member');
    const { rows: p } = await app.query<{ id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, status, priority)
       VALUES ($1, NULL, $2, 'todo', 'normal') RETURNING id`,
      [`${MARK} internal parent`, editor]);
    const { rows: c } = await app.query<{ id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, parent_id, status, priority)
       VALUES ($1, NULL, $2, $3, 'todo', 'normal') RETURNING id`,
      [`${MARK} internal child`, editor, p.rows?.[0]?.id ?? p[0]!.id]);
    expect(c[0]!.id).toBeTruthy();
  });

});

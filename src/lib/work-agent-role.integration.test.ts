import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The work agent's wall.
 *
 * Harder to get right than the finance agent's, because this one has to WRITE
 * to rows that already exist — assigning a task IS an update. The verb cannot
 * be withheld, so it is narrowed instead: a column-level grant on exactly
 * assignee_id, due_date and priority.
 *
 * The line that matters: it can move work around, and it can never mark work
 * done. Completion is the two-step human sign-off and stays human.
 */

const OWNER = process.env.DATABASE_URL;
const WORK = process.env.WORK_AGENT_DATABASE_URL;

async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const HAS_DB = (await reachable(OWNER)) && (await reachable(WORK));
const MARK = 'ZZZ work-agent probe';

describe.skipIf(!HAS_DB)('work agent role (integration)', () => {
  let owner: Client;
  let agent: Client;
  let projectId: string;
  let taskId: string;
  let memberId: string;
  let otherMemberId: string;

  beforeAll(async () => {
    owner = new Client({ connectionString: OWNER });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");

    const members = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'member' AND is_active
         AND email NOT LIKE '%@vixart.local' ORDER BY email LIMIT 2`,
    );
    memberId = members.rows[0]!.id;
    otherMemberId = members.rows[1]?.id ?? memberId;

    const company = await owner.query<{ id: string }>('SELECT id FROM company LIMIT 1');
    const project = await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [company.rows[0]!.id, MARK],
    );
    projectId = project.rows[0]!.id;

    const task = await owner.query<{ id: string }>(
      `INSERT INTO task (project_id, title, status, priority, assignee_id, created_by_id)
       VALUES ($1, $2, 'todo', 'normal', $3, $3) RETURNING id`,
      [projectId, MARK, memberId],
    );
    taskId = task.rows[0]!.id;

    agent = new Client({ connectionString: WORK });
    await agent.connect();
    await agent.query("SELECT set_config('app.user_role','work_agent',false)");
  });

  afterAll(async () => {
    if (agent) await agent.end();
    if (owner) {
      await owner.query("SET app.bootstrap = 'on'");
      await owner.query('DELETE FROM effort_log WHERE task_id IN (SELECT id FROM task WHERE title LIKE $1)', [`${MARK}%`]);
      await owner.query('DELETE FROM comment WHERE body LIKE $1', [`${MARK}%`]);
      await owner.query('DELETE FROM task WHERE title LIKE $1', [`${MARK}%`]);
      await owner.query('DELETE FROM project WHERE name = $1', [MARK]);
      await owner.end();
    }
  });

  // --- What it is for -------------------------------------------------------

  it('can read work, and cannot see money at all', async () => {
    for (const table of ['company', 'project', 'task', 'effort_log', 'capacity']) {
      const { rows } = await agent.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      expect(rows[0]!.n).toMatch(/^\d+$/);
    }

    // No grant at all on the money tables — it cannot learn what anything costs.
    for (const table of ['document', 'finance_entry', 'service_price', 'fiscal_rate']) {
      await expect(agent.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('can reassign a task', async () => {
    await agent.query('UPDATE task SET assignee_id = $1 WHERE id = $2', [otherMemberId, taskId]);
    const { rows } = await owner.query<{ assignee_id: string }>(
      'SELECT assignee_id FROM task WHERE id = $1',
      [taskId],
    );
    expect(rows[0]!.assignee_id).toBe(otherMemberId);
  });

  it('can reschedule and reprioritise a task', async () => {
    await agent.query(
      `UPDATE task SET due_date = current_date + 7, priority = 'high' WHERE id = $1`,
      [taskId],
    );
    const { rows } = await owner.query<{ priority: string; due_date: string | null }>(
      'SELECT priority, due_date FROM task WHERE id = $1',
      [taskId],
    );
    expect(rows[0]!.priority).toBe('high');
    expect(rows[0]!.due_date).not.toBeNull();
  });

  it('can create a task, and only ever an unstarted one', async () => {
    await agent.query(
      `INSERT INTO task (project_id, title, status, priority, created_by_id)
       VALUES ($1, $2, 'todo', 'normal', app.work_agent_user_id())`,
      [projectId, `${MARK} created`],
    );
    const { rows } = await owner.query<{ status: string; created_by: string }>(
      `SELECT t.status, u.email AS created_by FROM task t
         LEFT JOIN app_user u ON u.id = t.created_by_id
        WHERE t.title = $1`,
      [`${MARK} created`],
    );
    expect(rows[0]!.status).toBe('todo');
    // Attributable: the row says the agent opened it.
    expect(rows[0]!.created_by).toBe('chef@vixart.local');

    // It cannot open a task that is already finished. `enforce_task_insert`
    // coerces the status rather than raising, so the assertion is on the row
    // that lands, not on a rejection — the property is "no completed task
    // appears", and that holds whether the database refuses or rewrites.
    await agent
      .query(
        `INSERT INTO task (project_id, title, status, created_by_id)
         VALUES ($1, $2, 'completed', app.work_agent_user_id())`,
        [projectId, `${MARK} prebaked`],
      )
      .catch(() => undefined);

    const prebaked = await owner.query<{ status: string }>(
      'SELECT status FROM task WHERE title = $1',
      [`${MARK} prebaked`],
    );
    for (const row of prebaked.rows) {
      expect(row.status).not.toBe('completed');
    }
  });

  // --- The line ------------------------------------------------------------

  it('CANNOT mark a task done — completion stays human', async () => {
    const before = await owner.query<{ status: string }>(
      'SELECT status FROM task WHERE id = $1',
      [taskId],
    );

    for (const status of ['completed', 'submitted', 'in_progress']) {
      await agent
        .query('UPDATE task SET status = $1 WHERE id = $2', [status, taskId])
        .catch(() => undefined);
    }

    const after = await owner.query<{ status: string }>(
      'SELECT status FROM task WHERE id = $1',
      [taskId],
    );
    // Unchanged, whichever layer refused it — the column grant refuses the
    // statement before the trigger is even reached.
    expect(after.rows[0]!.status).toBe(before.rows[0]!.status);
  });

  it('CANNOT rewrite what a task is, or move it to another project', async () => {
    const before = await owner.query<{ title: string; project_id: string }>(
      'SELECT title, project_id FROM task WHERE id = $1',
      [taskId],
    );

    await agent.query(`UPDATE task SET title = 'rewritten' WHERE id = $1`, [taskId]).catch(() => undefined);
    await agent.query(`UPDATE task SET project_id = $1 WHERE id = $2`, [projectId, taskId]).catch(() => undefined);

    const after = await owner.query<{ title: string; project_id: string }>(
      'SELECT title, project_id FROM task WHERE id = $1',
      [taskId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('CANNOT delete anything', async () => {
    const before = await owner.query<{ tasks: string; projects: string }>(
      `SELECT (SELECT count(*)::text FROM task) AS tasks,
              (SELECT count(*)::text FROM project) AS projects`,
    );
    for (const statement of ['DELETE FROM task', 'DELETE FROM project', 'DELETE FROM comment']) {
      await agent.query(statement).catch(() => undefined);
    }
    const after = await owner.query<{ tasks: string; projects: string }>(
      `SELECT (SELECT count(*)::text FROM task) AS tasks,
              (SELECT count(*)::text FROM project) AS projects`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('CANNOT touch money, capacity, or anyone\'s account', async () => {
    for (const statement of [
      `UPDATE finance_entry SET amount_centimes = 1`,
      `INSERT INTO capacity (user_id, weekly_minutes) VALUES (gen_random_uuid(), 2400)`,
      `UPDATE app_user SET role = 'admin'`,
      `UPDATE project SET status = 'delivered'`,
    ]) {
      await agent.query(statement).catch(() => undefined);
    }
    const { rows } = await owner.query<{ admins: string; capacities: string }>(
      `SELECT (SELECT count(*)::text FROM app_user WHERE role='admin') AS admins,
              (SELECT count(*)::text FROM capacity) AS capacities`,
    );
    expect(rows[0]!.admins).toBe('1');
    expect(rows[0]!.capacities).toBe('0');
  });

  it('holds no bypass, is not an admin, and is not the finance agent', async () => {
    const { rows } = await agent.query<{
      is_work_agent: boolean; is_admin: boolean; is_authenticated: boolean; is_bootstrap: boolean;
    }>(`SELECT app.is_work_agent() AS is_work_agent, app.is_admin() AS is_admin,
               app.is_authenticated() AS is_authenticated, app.is_bootstrap() AS is_bootstrap`);
    expect(rows[0]!.is_work_agent).toBe(true);
    expect(rows[0]!.is_admin).toBe(false);
    expect(rows[0]!.is_authenticated).toBe(false);
    expect(rows[0]!.is_bootstrap).toBe(false);

    // The two agents are separate roles; neither inherits the other's reach.
    const bypass = await agent.query<{ rolbypassrls: boolean; rolsuper: boolean; me: string }>(
      'SELECT rolbypassrls, rolsuper, current_user AS me FROM pg_roles WHERE rolname = current_user',
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);
    expect(bypass.rows[0]!.rolsuper).toBe(false);
    expect(bypass.rows[0]!.me).toBe('vixart_agent_work');
  });
});

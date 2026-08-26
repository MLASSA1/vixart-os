import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { assignTask, createTask, projectHealth, unassigned, workload } from './work-tools';

/**
 * Le Chef's tools, against a real database on the real work-agent role.
 *
 * Same property as phase 1: not "does it return a number" but "does every
 * number arrive with its rows and its limits". The limit that matters here is
 * capacity — with none recorded, load must never be expressed as a percentage.
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
const MARK = 'ZZZ work-tools probe';

describe.skipIf(!HAS_DB)('work agent tools (integration)', () => {
  let owner: Client;
  let projectId: string;
  let memberId: string;
  let taskId: string;

  beforeAll(async () => {
    owner = new Client({ connectionString: OWNER });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");

    const member = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'member' AND is_active
         AND email NOT LIKE '%@vixart.local' LIMIT 1`,
    );
    memberId = member.rows[0]!.id;

    const company = await owner.query<{ id: string }>('SELECT id FROM company LIMIT 1');
    const project = await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status, due_date)
       VALUES ($1, $2, 'active', current_date - 3) RETURNING id`,
      [company.rows[0]!.id, MARK],
    );
    projectId = project.rows[0]!.id;

    const task = await owner.query<{ id: string }>(
      `INSERT INTO task (project_id, title, status, priority, due_date, created_by_id)
       VALUES ($1, $2, 'todo', 'high', current_date - 1, $3) RETURNING id`,
      [projectId, `${MARK} unassigned`, memberId],
    );
    taskId = task.rows[0]!.id;
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query('DELETE FROM effort_log WHERE task_id IN (SELECT id FROM task WHERE title LIKE $1)', [`${MARK}%`]);
    await owner.query('DELETE FROM task WHERE title LIKE $1', [`${MARK}%`]);
    await owner.query('DELETE FROM project WHERE name = $1', [MARK]);
    await owner.end();
  });

  it('workload reports load without inventing a denominator', async () => {
    const r = await workload();
    expect(r.sources[0]!.table).toBe('app_user');
    expect(r.data.people.length).toBeGreaterThan(0);

    const { rows } = await owner.query<{ n: string }>('SELECT count(*)::text AS n FROM capacity');
    if (rows[0]!.n === '0') {
      // No capacity anywhere, so no percentage may appear.
      expect(r.caveats?.join(' ')).toMatch(/No capacity is recorded/i);
      expect(r.caveats?.join(' ')).toMatch(/NOT as a percentage/i);
      for (const p of r.data.people) expect(p.weeklyCapacityMinutes).toBeNull();
    }
  });

  it('workload does not present missing effort data as an idle team', async () => {
    const r = await workload();
    if (r.data.people.every((p) => p.loggedMinutesLast30 === 0)) {
      expect(r.caveats?.join(' ')).toMatch(/missing data rather than an idle month/i);
    }
  });

  it('unassigned finds work nobody has picked up', async () => {
    const r = await unassigned();
    const mine = r.data.tasks.find((t) => t.id === taskId);
    expect(mine).toBeDefined();
    expect(mine!.priority).toBe('high');
    expect(mine!.daysUntilDue).toBeLessThan(0); // already overdue
    expect(r.sources.some((s) => s.table === 'task')).toBe(true);
  });

  it('project health reports lateness and says what "quiet" means', async () => {
    const r = await projectHealth();
    const mine = r.data.projects.find((p) => p.name === MARK);
    expect(mine).toBeDefined();
    expect(mine!.daysLate).toBeGreaterThan(0);
    expect(mine!.overdueTasks).toBeGreaterThan(0);
    expect(r.caveats?.join(' ')).toMatch(/a question, not a verdict/i);
  });

  it('assign_task moves work and admits nobody was told', async () => {
    const r = await assignTask(taskId, memberId, null);
    expect(r.data.taskId).toBe(taskId);
    expect(r.caveats?.join(' ')).toMatch(/Nobody has been told/i);

    const { rows } = await owner.query<{ assignee_id: string; status: string }>(
      'SELECT assignee_id, status FROM task WHERE id = $1',
      [taskId],
    );
    expect(rows[0]!.assignee_id).toBe(memberId);
    // Assigning never advances the work.
    expect(rows[0]!.status).toBe('todo');
  });

  it('create_task opens an unstarted task attributed to the agent', async () => {
    const r = await createTask(projectId, `${MARK} new`, null, null, 'urgent');
    expect(r.data.taskId).toBeTruthy();
    expect(r.caveats?.join(' ')).toMatch(/no assignee/i);

    const { rows } = await owner.query<{ status: string; priority: string; created_by: string }>(
      `SELECT t.status, t.priority, u.email AS created_by
         FROM task t LEFT JOIN app_user u ON u.id = t.created_by_id
        WHERE t.id = $1`,
      [r.data.taskId],
    );
    expect(rows[0]!.status).toBe('todo');
    expect(rows[0]!.priority).toBe('urgent');
    expect(rows[0]!.created_by).toBe('chef@vixart.local');
  });

  it('leaves an audit trail under its own name', async () => {
    const { rows } = await owner.query<{ actor_name: string; action: string }>(
      `SELECT actor_name, action FROM activity
        WHERE entity_type = 'task' AND entity_label LIKE $1
        ORDER BY created_at DESC LIMIT 1`,
      [`${MARK}%`],
    );
    // An agent that could act without being logged would be worse than one
    // that could not act.
    expect(rows[0]?.actor_name).toBe('Le Chef');
  });

  it('every tool returns sources', async () => {
    for (const r of [await workload(), await unassigned(), await projectHealth()]) {
      expect(r.sources.length).toBeGreaterThan(0);
      for (const s of r.sources) {
        expect(s.table).toBeTruthy();
        expect(s.ids.length).toBeLessThanOrEqual(60);
      }
    }
  });
});

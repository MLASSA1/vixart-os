import 'server-only';

import { sql } from 'drizzle-orm';
import { asWorkAgent } from './work-db';
import { parseDate, source, today, type ToolResult } from './contract';

/**
 * VIXART OS — Le Chef's tools.
 *
 * Same contract as the finance tools: never a figure without the rows it came
 * from, and never a figure without what it leaves out. The caveat that matters
 * here is capacity — nobody has told this system how many hours a week anyone
 * works, so load is reported as counts and minutes, never as a percentage of
 * anything. Inventing a denominator would make every number look authoritative
 * and be fiction.
 */

type Row = Record<string, unknown>;

/** Is anyone's capacity actually known? */
async function capacityCaveat(
  tx: Parameters<Parameters<typeof asWorkAgent>[0]>[0],
): Promise<string[]> {
  const result = await tx.execute<Row>(sql`
    SELECT (SELECT count(*)::text FROM capacity) AS set_for,
           -- app.team_directory, not app_user: this role cannot read the table,
           -- and that is the point — the view has no password_hash to leak.
           (SELECT count(*)::text FROM app.team_directory WHERE is_active) AS people
  `);
  const setFor = Number(result.rows[0]?.set_for ?? 0);

  if (setFor === 0) {
    return [
      'No capacity is recorded for anyone, so load is reported as open task ' +
        'counts and logged minutes — NOT as a percentage of what someone can take. ' +
        'Whether a person is overloaded is a judgement, not a figure, until ' +
        'weekly capacity is set.',
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------

export interface WorkloadData {
  people: Array<{
    userId: string; name: string; jobTitle: string | null;
    openTasks: number; overdue: number; dueThisWeek: number;
    submittedAwaitingSignOff: number;
    loggedMinutesLast30: number;
    weeklyCapacityMinutes: number | null;
  }>;
}

/** Who is carrying what. */
export async function workload(): Promise<ToolResult<WorkloadData>> {
  return asWorkAgent(async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT u.id::text AS user_id, u.full_name, u.job_title,
             (SELECT count(*) FROM task t
               WHERE t.assignee_id = u.id AND t.status <> 'completed')      AS open_tasks,
             (SELECT count(*) FROM task t
               WHERE t.assignee_id = u.id AND t.status <> 'completed'
                 AND t.due_date IS NOT NULL AND t.due_date < current_date)  AS overdue,
             (SELECT count(*) FROM task t
               WHERE t.assignee_id = u.id AND t.status <> 'completed'
                 AND t.due_date BETWEEN current_date AND current_date + 7)  AS due_week,
             (SELECT count(*) FROM task t
               WHERE t.assignee_id = u.id AND t.status = 'submitted')       AS submitted,
             coalesce((SELECT sum(e.minutes) FROM effort_log e
                        WHERE e.user_id = u.id
                          AND e.logged_on >= current_date - 30), 0)::int    AS minutes_30,
             (SELECT c.weekly_minutes FROM capacity c
               WHERE c.user_id = u.id AND c.effective_from <= current_date
               ORDER BY c.effective_from DESC LIMIT 1)                      AS capacity
        FROM app.team_directory u
       WHERE u.is_active AND u.role <> 'admin'
       ORDER BY u.full_name
    `);

    const people = result.rows.map((r) => ({
      userId: String(r.user_id),
      name: String(r.full_name),
      jobTitle: (r.job_title as string) ?? null,
      openTasks: Number(r.open_tasks),
      overdue: Number(r.overdue),
      dueThisWeek: Number(r.due_week),
      submittedAwaitingSignOff: Number(r.submitted),
      loggedMinutesLast30: Number(r.minutes_30),
      weeklyCapacityMinutes: r.capacity === null ? null : Number(r.capacity),
    }));

    const caveats = await capacityCaveat(tx);
    if (people.every((p) => p.loggedMinutesLast30 === 0)) {
      caveats.push(
        'Nobody has logged any effort in the last 30 days. That is almost ' +
          'certainly missing data rather than an idle month, so minutes here ' +
          'say nothing about who is actually busy.',
      );
    }

    return {
      data: { people },
      sources: [source('app_user', people.map((p) => p.userId))],
      caveats,
    };
  });
}

// ---------------------------------------------------------------------------

export interface UnassignedData {
  tasks: Array<{
    id: string; title: string; project: string; company: string;
    priority: string; dueDate: string | null; daysUntilDue: number | null;
  }>;
  projectsWithNoTasks: Array<{ id: string; name: string; company: string }>;
}

/** What is waiting for someone to pick it up. */
export async function unassigned(): Promise<ToolResult<UnassignedData>> {
  return asWorkAgent(async (tx) => {
    const tasks = await tx.execute<Row>(sql`
      SELECT t.id::text, t.title, p.name AS project, c.name AS company,
             t.priority, t.due_date::text AS due_date,
             CASE WHEN t.due_date IS NULL THEN NULL
                  ELSE (t.due_date - current_date) END AS days_until
        FROM task t
        JOIN project p ON p.id = t.project_id
        JOIN company c ON c.id = p.company_id
       WHERE t.assignee_id IS NULL AND t.status <> 'completed'
       ORDER BY t.due_date NULLS LAST,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                                WHEN 'normal' THEN 2 ELSE 3 END
    `);

    const empty = await tx.execute<Row>(sql`
      SELECT p.id::text, p.name, c.name AS company
        FROM project p JOIN company c ON c.id = p.company_id
       WHERE p.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM task t WHERE t.project_id = p.id)
       ORDER BY p.name
    `);

    return {
      data: {
        tasks: tasks.rows.map((r) => ({
          id: String(r.id),
          title: String(r.title),
          project: String(r.project),
          company: String(r.company),
          priority: String(r.priority),
          dueDate: (r.due_date as string) ?? null,
          daysUntilDue: r.days_until === null ? null : Number(r.days_until),
        })),
        projectsWithNoTasks: empty.rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          company: String(r.company),
        })),
      },
      sources: [
        source('task', tasks.rows.map((r) => String(r.id))),
        source('project', empty.rows.map((r) => String(r.id))),
      ],
      caveats:
        tasks.rows.length === 0 && empty.rows.length === 0
          ? ['Nothing is unassigned. If that seems wrong, the work may not be in the system yet.']
          : undefined,
    };
  });
}

// ---------------------------------------------------------------------------

export interface ProjectHealthData {
  projects: Array<{
    id: string; name: string; company: string; status: string;
    dueDate: string | null; daysLate: number | null;
    openTasks: number; overdueTasks: number; awaitingSignOff: number;
    lastActivity: string | null; daysSinceActivity: number | null;
  }>;
}

/** Which jobs are slipping. */
export async function projectHealth(): Promise<ToolResult<ProjectHealthData>> {
  return asWorkAgent(async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT p.id::text, p.name, c.name AS company, p.status,
             p.due_date::text AS due_date,
             CASE WHEN p.due_date IS NULL OR p.due_date >= current_date THEN NULL
                  ELSE (current_date - p.due_date) END AS days_late,
             (SELECT count(*) FROM task t
               WHERE t.project_id = p.id AND t.status <> 'completed')     AS open_tasks,
             (SELECT count(*) FROM task t
               WHERE t.project_id = p.id AND t.status <> 'completed'
                 AND t.due_date IS NOT NULL AND t.due_date < current_date) AS overdue_tasks,
             (SELECT count(*) FROM task t
               WHERE t.project_id = p.id AND t.status = 'submitted')       AS awaiting,
             (SELECT max(t.updated_at)::text FROM task t
               WHERE t.project_id = p.id)                                  AS last_activity,
             (SELECT (current_date - max(t.updated_at)::date) FROM task t
               WHERE t.project_id = p.id)                                  AS days_quiet
        FROM project p JOIN company c ON c.id = p.company_id
       WHERE p.status IN ('planned','active','on_hold')
       ORDER BY p.due_date NULLS LAST, p.name
    `);

    return {
      data: {
        projects: result.rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          company: String(r.company),
          status: String(r.status),
          dueDate: (r.due_date as string) ?? null,
          daysLate: r.days_late === null ? null : Number(r.days_late),
          openTasks: Number(r.open_tasks),
          overdueTasks: Number(r.overdue_tasks),
          awaitingSignOff: Number(r.awaiting),
          lastActivity: (r.last_activity as string) ?? null,
          daysSinceActivity: r.days_quiet === null ? null : Number(r.days_quiet),
        })),
      },
      sources: [source('project', result.rows.map((r) => String(r.id)))],
      caveats: [
        'Activity means the last time a task on the project was touched. A project ' +
          'can be moving without that changing — a quiet project is a question, not a verdict.',
      ],
    };
  });
}

// ---------------------------------------------------------------------------

export interface AssignData {
  taskId: string;
  title: string;
  assignedTo: string;
  dueDate: string | null;
}

/**
 * Hands a task to someone.
 *
 * The agent cannot mark anything done — the column grant refuses an UPDATE
 * naming `status`, and the trigger says so again. It moves work; it never
 * declares it finished.
 */
export async function assignTask(
  taskId: string,
  userId: string,
  dueDate: string | null,
): Promise<ToolResult<AssignData>> {
  if (!taskId || !userId) throw new Error('Both a task and a person are needed.');
  const due = dueDate ? parseDate(dueDate, today()) : null;

  return asWorkAgent(async (tx) => {
    await tx.execute(
      due
        ? sql`UPDATE task SET assignee_id = ${userId}::uuid, due_date = ${due}::date WHERE id = ${taskId}::uuid`
        : sql`UPDATE task SET assignee_id = ${userId}::uuid WHERE id = ${taskId}::uuid`,
    );

    const check = await tx.execute<Row>(sql`
      SELECT t.id::text, t.title, u.full_name, t.due_date::text AS due_date
        FROM task t LEFT JOIN app.team_directory u ON u.id = t.assignee_id
       WHERE t.id = ${taskId}::uuid
    `);
    const row = check.rows[0];
    if (!row) throw new Error('That task does not exist, or the change did not take.');

    return {
      data: {
        taskId: String(row.id),
        title: String(row.title),
        assignedTo: String(row.full_name ?? 'nobody'),
        dueDate: (row.due_date as string) ?? null,
      },
      sources: [source('task', [String(row.id)])],
      caveats: [
        'The task has been reassigned. Nobody has been told — there is no ' +
          'notification, no email and no message. Tell them.',
      ],
    };
  });
}

// ---------------------------------------------------------------------------

export interface CreateTaskData {
  taskId: string;
  title: string;
  project: string;
  assignedTo: string | null;
}

/** Opens a task. Always unstarted. */
export async function createTask(
  projectId: string,
  title: string,
  assigneeId: string | null,
  dueDate: string | null,
  priority: string | null,
): Promise<ToolResult<CreateTaskData>> {
  if (!projectId || !title.trim()) throw new Error('A project and a title are needed.');

  const allowed = ['low', 'normal', 'high', 'urgent'];
  const chosen = priority && allowed.includes(priority) ? priority : 'normal';
  const due = dueDate ? parseDate(dueDate, today()) : null;

  return asWorkAgent(async (tx) => {
    const created = await tx.execute<Row>(sql`
      INSERT INTO task (project_id, title, status, priority, assignee_id, due_date, created_by_id)
      VALUES (${projectId}::uuid, ${title.trim()}, 'todo', ${chosen},
              ${assigneeId}::uuid, ${due}::date, app.work_agent_user_id())
      RETURNING id::text
    `);
    const taskId = String(created.rows[0]?.id);

    const check = await tx.execute<Row>(sql`
      SELECT t.title, p.name AS project, u.full_name
        FROM task t JOIN project p ON p.id = t.project_id
        LEFT JOIN app.team_directory u ON u.id = t.assignee_id
       WHERE t.id = ${taskId}::uuid
    `);
    const row = check.rows[0];

    return {
      data: {
        taskId,
        title: String(row?.title ?? title),
        project: String(row?.project ?? ''),
        assignedTo: (row?.full_name as string) ?? null,
      },
      sources: [source('task', [taskId])],
      caveats: [
        'The task exists and is unstarted. Nobody has been notified.',
        ...(assigneeId ? [] : ['It has no assignee — it will sit in the unassigned list until someone takes it.']),
      ],
    };
  });
}

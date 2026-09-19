import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { TaskRow, type TaskItem } from '@/components/TaskRow';
import { withUser } from '@/db/session';

export const dynamic = 'force-dynamic';

/**
 * My work — what this person owes, and nothing else.
 *
 * The landing page for a team member: their open tasks, the projects they are
 * on, and what is waiting on someone else's sign-off.
 */
export default async function MyWorkPage() {
  const session = await auth();
  const me = session!.user;
  const canModerate = me.role === 'admin' || me.role === 'moderator';

  const rows = await withUser(async (tx) => {
    const result = await tx.execute<TaskItem & { [k: string]: unknown }>(sql`
      SELECT t.id, t.title, t.description, t.status, t.priority,
             t.due_date::text AS due_date, t.project_id,
             a.full_name AS assignee_name, t.assignee_id,
             t.created_by_id, r.full_name AS raised_by_name,
             t.blocked_reason, t.parent_id,
             (SELECT count(*)::int FROM task c
               WHERE c.parent_id = t.id AND c.status <> 'completed') AS open_children,
             p.name AS project_name, c.name AS company_name,
             s.full_name AS completed_by_name
        FROM task t
        LEFT JOIN project p ON p.id = t.project_id
        LEFT JOIN company c ON c.id = p.company_id
        LEFT JOIN app_user a ON a.id = t.assignee_id
        LEFT JOIN app_user s ON s.id = t.completed_by_id
        LEFT JOIN app_user r ON r.id = t.created_by_id
       WHERE t.assignee_id = ${me.id}
          -- Raised by me and carried by somebody else: I need to see it, and
          -- especially to see it stuck.
          OR t.created_by_id = ${me.id}
          -- Waiting on my sign-off. Only a moderator can act on these, and the
          -- section is hidden for everyone else.
          OR (t.status = 'submitted' AND ${canModerate})
       ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1
                              WHEN 'accepted' THEN 2 WHEN 'todo' THEN 3
                              WHEN 'submitted' THEN 4 ELSE 5 END,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                                WHEN 'normal' THEN 2 ELSE 3 END,
                t.due_date NULLS LAST
    `);
    return result.rows as TaskItem[];
  });

  /*
   * Four questions a team member has, in the order they have them:
   *   what am I meant to be doing,
   *   what did I ask for that has not come back,
   *   what is stuck,
   *   and what is waiting on me to sign it off.
   *
   * One query, grouped here rather than four round trips.
   */
  const mine = rows.filter(
    (t) => t.assignee_id === me.id && t.status !== 'completed' && t.status !== 'submitted',
  );
  const raised = rows.filter(
    (t) => t.created_by_id === me.id && t.assignee_id !== me.id && t.status !== 'completed',
  );
  const blocked = rows.filter((t) => t.status === 'blocked');
  const waiting = rows.filter((t) => t.status === 'submitted');
  const done = rows.filter((t) => t.status === 'completed' && t.assignee_id === me.id);
  const overdue = mine.filter(
    (t) => t.due_date && new Date(t.due_date) < new Date(),
  ).length;

  return (
    <>
      <PageHeader eyebrow={me.name ?? 'Team'} title="My work" />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Mine</p>
          <p className="kpi mt-1">{mine.length}</p>
        </div>
        <div>
          <p className="label">Overdue</p>
          <p className="kpi mt-1">{overdue}</p>
        </div>
        <div>
          <p className="label">Awaiting sign-off</p>
          <p className="kpi mt-1">{waiting.length}</p>
        </div>
        <div>
          <p className="label">Signed off</p>
          <p className="kpi mt-1">{done.length}</p>
        </div>
      </div>

      <Section title={`Assigned to me — ${mine.length}`}>
        {mine.length === 0 ? (
          <Empty message="Nothing assigned. Anyone can raise a task — including you, for yourself." />
        ) : (
          <ul className="border-t border-void/10">
            {mine.map((t) => (
              <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
            ))}
          </ul>
        )}
      </Section>

      {raised.length > 0 && (
        <Section title={`Raised by me — ${raised.length}`}>
          <p className="hint mb-3">
            Work you asked somebody else for. You are told here when one of them
            says it is blocked.
          </p>
          <ul className="border-t border-void/10">
            {raised.map((t) => (
              <TaskRow key={t.id} task={t} canModerate={canModerate} showProject />
            ))}
          </ul>
        </Section>
      )}

      {blocked.length > 0 && (
        <Section title={`Blocked — ${blocked.length}`}>
          <p className="hint mb-3">
            Stuck on somebody or something else. The reason is the point — a
            block with no reason is just a task nobody is moving.
          </p>
          <ul className="border-t border-void/10">
            {blocked.map((t) => (
              <li key={t.id} className="border-b border-void/10 py-1">
                <TaskRow
                  task={t}
                  isMine={t.assignee_id === me.id}
                  canModerate={canModerate}
                  showProject
                />
                {t.blocked_reason ? (
                  <p className="tone-warn mb-2 ml-1 inline-block rounded-[8px] px-2.5 py-1 text-[13px]">
                    {t.blocked_reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {waiting.length > 0 && (
        <Section
          title={
            canModerate
              ? `Awaiting my sign-off — ${waiting.length}`
              : `Waiting on sign-off — ${waiting.length}`
          }
        >
          <p className="hint mb-3">
            {canModerate
              ? 'Submitted as finished. Nobody signs off their own work, so these need you.'
              : 'You marked these done. A moderator confirms them before they count as completed.'}
          </p>
          <ul className="border-t border-void/10">
            {waiting.map((t) => (
              <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
            ))}
          </ul>
        </Section>
      )}

      {done.length > 0 && (
        <Section title={`Signed off — ${done.length}`}>
          <ul className="border-t border-void/10">
            {done.slice(0, 20).map((t) => (
              <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

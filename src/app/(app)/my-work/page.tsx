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
             p.name AS project_name, c.name AS company_name,
             s.full_name AS completed_by_name
        FROM task t
        JOIN project p ON p.id = t.project_id
        JOIN company c ON c.id = p.company_id
        LEFT JOIN app_user a ON a.id = t.assignee_id
        LEFT JOIN app_user s ON s.id = t.completed_by_id
       WHERE t.assignee_id = ${me.id}
       ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1
                              WHEN 'submitted' THEN 2 ELSE 3 END,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                                WHEN 'normal' THEN 2 ELSE 3 END,
                t.due_date NULLS LAST
    `);
    return result.rows as TaskItem[];
  });

  const open = rows.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const waiting = rows.filter((t) => t.status === 'submitted');
  const done = rows.filter((t) => t.status === 'completed');
  const overdue = open.filter(
    (t) => t.due_date && new Date(t.due_date) < new Date(),
  ).length;

  return (
    <>
      <PageHeader eyebrow={me.name ?? 'Team'} title="My work" />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Open</p>
          <p className="kpi mt-1">{open.length}</p>
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

      <Section title={`Open — ${open.length}`}>
        {open.length === 0 ? (
          <Empty message="Nothing open. Tasks appear here when a moderator assigns them to you." />
        ) : (
          <ul className="border-t border-void/10">
            {open.map((t) => (
              <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
            ))}
          </ul>
        )}
      </Section>

      {waiting.length > 0 && (
        <Section title={`Waiting on sign-off — ${waiting.length}`}>
          <p className="hint mb-3">
            You marked these done. A moderator confirms them before they count as
            completed.
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

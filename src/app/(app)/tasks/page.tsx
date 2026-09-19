import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { TaskRow, type TaskItem } from '@/components/TaskRow';
import { withUser } from '@/db/session';
import { capped, DONE_WINDOW, QUERY_CAP } from '@/lib/list-caps';
import { createTaskAction } from '../projects/actions';
import { TaskForm } from '../projects/TaskForm';

export const dynamic = 'force-dynamic';

/**
 * Tasks — every piece of work, wherever it belongs.
 *
 * Separate from a project page on purpose. A project page answers "what is
 * left on the Talborjt film"; this answers "what am I doing today", and since
 * 0055 a task does not need a project at all — fixing the studio lighting is
 * work, and forcing it under a client engagement either invents a fake project
 * or means it never gets written down.
 *
 * Anyone can raise one here, for themselves or for somebody else. Sign-off is
 * unchanged: a moderator or an admin, never the person who did it.
 */
export default async function TasksPage() {
  const session = await auth();
  const me = session!.user;
  const canModerate = me.role === 'admin' || me.role === 'moderator';

  const { rows, team, projects } = await withUser(async (tx) => {
    const result = await tx.execute<TaskItem & { [k: string]: unknown }>(sql`
      SELECT t.id, t.title, t.description, t.status, t.priority,
             t.due_date::text AS due_date, t.project_id,
             t.completed_at::text AS completed_at,
             a.full_name AS assignee_name, t.assignee_id,
             t.created_by_id, r.full_name AS raised_by_name,
             t.blocked_reason, t.parent_id,
             p.name AS project_name, c.name AS company_name,
             s.full_name AS completed_by_name,
             (SELECT count(*)::int FROM task k
               WHERE k.parent_id = t.id AND k.status <> 'completed') AS open_children
        FROM task t
        LEFT JOIN project p ON p.id = t.project_id
        LEFT JOIN company c ON c.id = p.company_id
        LEFT JOIN app_user a ON a.id = t.assignee_id
        LEFT JOIN app_user r ON r.id = t.created_by_id
        LEFT JOIN app_user s ON s.id = t.completed_by_id
       -- Open work in full, and only the tail of what is finished. The
       -- completed pile grows for ever and none of it is actionable; without
       -- this the page carried every task the agency has ever signed off.
       WHERE t.status <> 'completed'
          OR t.completed_at > now() - ${DONE_WINDOW}::interval
       ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1
                              WHEN 'accepted' THEN 2 WHEN 'todo' THEN 3
                              WHEN 'submitted' THEN 4 ELSE 5 END,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                                WHEN 'normal' THEN 2 ELSE 3 END,
                t.due_date NULLS LAST, t.created_at DESC
       LIMIT ${QUERY_CAP}
    `);

    const people = await tx.execute<{ id: string; full_name: string }>(sql`
      SELECT id, full_name FROM app.team_directory
       -- Work goes to somebody who can sign in and see it. The database
       -- refuses the rest (0062); this is so they are not offered.
       WHERE is_active AND is_person ORDER BY full_name
    `);

    const open = await tx.execute<{ id: string; label: string }>(sql`
      SELECT p.id, p.name || ' — ' || c.name AS label
        FROM project p JOIN company c ON c.id = p.company_id
       WHERE p.status <> 'delivered' AND p.archived_at IS NULL ORDER BY lower(p.name)
    `);

    return { rows: result.rows as TaskItem[], team: people.rows, projects: open.rows };
  });

  const mine = rows.filter(
    (t) => t.assignee_id === me.id && t.status !== 'completed' && t.status !== 'submitted',
  );
  const raised = rows.filter(
    (t) => t.created_by_id === me.id && t.assignee_id !== me.id && t.status !== 'completed',
  );
  const blocked = rows.filter((t) => t.status === 'blocked');
  const waiting = rows.filter((t) => t.status === 'submitted');
  /* Work with no client engagement behind it. */
  const internal = rows.filter((t) => !t.project_id && t.status !== 'completed');
  const history = rows.filter((t) => t.status === 'completed');

  return (
    <>
      <PageHeader eyebrow="Work" title="Tasks" />

      <p className="prose-vixart" style={{ opacity: 0.7 }}>
        Anyone can raise a task — for themselves, or for someone else. A task
        does not need a project: internal work belongs here too. Whoever it is
        assigned to says where it stands; a moderator signs it off.
      </p>

      <Section title="Raise a task">
        <TaskForm
          action={createTaskAction.bind(null, null)}
          team={team}
          meId={me.id}
          projects={projects}
        />
      </Section>

      <Section title={`Assigned to me — ${mine.length}`}>
        {mine.length === 0 ? (
          <Empty message="Nothing assigned to you." />
        ) : (
          <ul className="border-t border-void/10">
            {capped(mine).shown.map((t) => (
              <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
            ))}
          </ul>
        )}
        {capped(mine).hidden > 0 && (
          <p className="hint mt-3">{capped(mine).hidden} more not shown.</p>
        )}
      </Section>

      {raised.length > 0 && (
        <Section title={`Raised by me — ${raised.length}`}>
          <p className="hint mb-3">
            Work you asked somebody else for. You are told here when one of them
            says it is blocked.
          </p>
          <ul className="border-t border-void/10">
            {capped(raised).shown.map((t) => (
              <TaskRow key={t.id} task={t} canModerate={canModerate} showProject />
            ))}
          </ul>
          {capped(raised).hidden > 0 && (
            <p className="hint mt-3">{capped(raised).hidden} more not shown.</p>
          )}
        </Section>
      )}

      {blocked.length > 0 && (
        <Section title={`Blocked — ${blocked.length}`}>
          <ul className="border-t border-void/10">
            {capped(blocked).shown.map((t) => (
              <li key={t.id}>
                <TaskRow
                  task={t}
                  isMine={t.assignee_id === me.id}
                  canModerate={canModerate}
                  showProject
                />
                {t.blocked_reason && (
                  <p className="tone-warn mb-2 ml-1 inline-block rounded-[8px] px-2.5 py-1 text-[13px]">
                    {t.blocked_reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {capped(blocked).hidden > 0 && (
            <p className="hint mt-3">{capped(blocked).hidden} more not shown.</p>
          )}
        </Section>
      )}

      {internal.length > 0 && (
        <Section title={`Internal — ${internal.length}`}>
          <p className="hint mb-3">
            Work that belongs to the agency rather than to a client project.
          </p>
          <ul className="border-t border-void/10">
            {capped(internal).shown.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                isMine={t.assignee_id === me.id}
                canModerate={canModerate}
              />
            ))}
          </ul>
          {capped(internal).hidden > 0 && (
            <p className="hint mt-3">{capped(internal).hidden} more not shown.</p>
          )}
        </Section>
      )}

      {canModerate && waiting.length > 0 && (
        <Section title={`Awaiting sign-off — ${waiting.length}`}>
          <p className="hint mb-3">
            Submitted as finished. Nobody signs off their own work, so these need you.
          </p>
          <ul className="border-t border-void/10">
            {capped(waiting).shown.map((t) => (
              <TaskRow key={t.id} task={t} canModerate={canModerate} showProject />
            ))}
          </ul>
          {capped(waiting).hidden > 0 && (
            <p className="hint mt-3">{capped(waiting).hidden} more not shown.</p>
          )}
        </Section>
      )}

      {history.length > 0 && (
        <Section title={`Completed — ${history.length}`}>
          <p className="hint mb-3">
            Signed off in the last thirty days. Kept as the record of what was
            actually delivered.
          </p>
          <ul className="border-t border-void/10">
            {capped(history).shown.map((t) => (
              <TaskRow key={t.id} task={t} canModerate={canModerate} showProject />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

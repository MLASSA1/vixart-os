import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, Field, PageHeader, Section } from '@/components/ui';
import { TaskRow, type TaskItem } from '@/components/TaskRow';
import { withUser } from '@/db/session';
import { PROJECT_STATUS_LABELS } from '@/lib/labels';
import { formatDate } from '@/lib/format';
import { TaskForm } from '../TaskForm';
import { createTaskAction } from '../actions';

export const dynamic = 'force-dynamic';

interface ProjectRow {
  [k: string]: unknown;
  id: string;
  name: string;
  description: string | null;
  status: string;
  company_id: string;
  company_name: string;
  lead_name: string | null;
  start_date: string | null;
  due_date: string | null;
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const me = session!.user;
  const canModerate = me.role === 'admin' || me.role === 'moderator';

  const data = await withUser(async (tx) => {
    const p = await tx.execute<ProjectRow>(sql`
      SELECT p.id, p.name, p.description, p.status, p.company_id,
             c.name AS company_name, u.full_name AS lead_name,
             p.start_date::text AS start_date, p.due_date::text AS due_date
        FROM project p
        JOIN company c ON c.id = p.company_id
        LEFT JOIN app_user u ON u.id = p.lead_id
       WHERE p.id = ${id}
    `);
    const record = p.rows[0];
    if (!record) return null;

    const tasks = await tx.execute<TaskItem & { [k: string]: unknown }>(sql`
      SELECT t.id, t.title, t.description, t.status, t.priority,
             t.due_date::text AS due_date, t.project_id,
             a.full_name AS assignee_name, t.assignee_id,
             s.full_name AS completed_by_name
        FROM task t
        LEFT JOIN app_user a ON a.id = t.assignee_id
        LEFT JOIN app_user s ON s.id = t.completed_by_id
       WHERE t.project_id = ${id}
       ORDER BY CASE t.status WHEN 'submitted' THEN 0 WHEN 'in_progress' THEN 1
                              WHEN 'todo' THEN 2 ELSE 3 END,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                                WHEN 'normal' THEN 2 ELSE 3 END,
                t.due_date NULLS LAST
    `);
    const members = await tx.execute<{ id: string; full_name: string }>(
      sql`SELECT id, full_name FROM app_user WHERE is_active ORDER BY full_name`,
    );
    return { record, tasks: tasks.rows as TaskItem[], team: members.rows };
  });

  if (!data) notFound();
  const { record, tasks, team } = data;

  const awaiting = tasks.filter((t) => t.status === 'submitted');
  const openTasks = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const completed = tasks.filter((t) => t.status === 'completed');

  return (
    <>
      <PageHeader eyebrow={record.company_name} title={record.name} />

      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <Field label="Status" value={PROJECT_STATUS_LABELS[record.status]} />
          <Field label="Project lead" value={record.lead_name} />
          <Field
            label="Client"
            value={
              <Link
                href={`/companies/${record.company_id}`}
                className="underline underline-offset-4"
              >
                {record.company_name}
              </Link>
            }
          />
        </div>
        <div>
          <Field label="Start" value={record.start_date ? formatDate(record.start_date) : null} />
          <Field label="Due" value={record.due_date ? formatDate(record.due_date) : null} />
          <Field label="Tasks" value={`${openTasks.length} open / ${tasks.length}`} />
        </div>
      </div>

      {record.description && <p className="prose-vixart mt-6">{record.description}</p>}

      {awaiting.length > 0 && (
        <Section title={`Awaiting sign-off — ${awaiting.length}`}>
          <p className="hint mb-3">
            {canModerate
              ? 'These are done as far as the team is concerned. Confirm or send them back.'
              : 'Submitted and waiting on a moderator.'}
          </p>
          <ul className="border-t border-void/10">
            {awaiting.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                isMine={t.assignee_id === me.id}
                canModerate={canModerate}
              />
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Open tasks — ${openTasks.length}`}>
        {openTasks.length === 0 ? (
          <Empty message="Nothing open on this project" />
        ) : (
          <ul className="border-t border-void/10">
            {openTasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                isMine={t.assignee_id === me.id}
                canModerate={canModerate}
              />
            ))}
          </ul>
        )}
        {canModerate && <TaskForm action={createTaskAction.bind(null, record.id)} team={team} />}
      </Section>

      {completed.length > 0 && (
        <Section title={`Completed — ${completed.length}`}>
          <ul className="border-t border-void/10">
            {completed.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                isMine={t.assignee_id === me.id}
                canModerate={canModerate}
              />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

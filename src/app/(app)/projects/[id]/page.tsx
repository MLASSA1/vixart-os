import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, Field, PageHeader, Section } from '@/components/ui';
import { TaskRow, type TaskItem } from '@/components/TaskRow';
import { withUser } from '@/db/session';
import { Attachments } from '@/components/Attachments';
import { listAttachments, uploadAttachmentAction } from '@/lib/attachment-actions';
import { PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '@/lib/labels';
import { Comments, type CommentItem } from '@/components/Comments';
import { addCommentAction, deleteCommentAction } from '../../comments-actions';
import { formatDate } from '@/lib/format';
import { TaskForm } from '../TaskForm';
import { createTaskAction, deleteProjectAction, setProjectArchivedAction } from '../actions';

export const dynamic = 'force-dynamic';

interface ProjectRow {
  [k: string]: unknown;
  id: string;
  name: string;
  description: string | null;
  status: string;
  project_type: string;
  company_id: string;
  company_name: string;
  lead_name: string | null;
  start_date: string | null;
  due_date: string | null;
  archived_at: string | null;
  /** Messages in this project's channel. Nonzero means delete is refused. */
  message_count: number;
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
      SELECT p.id, p.name, p.description, p.status, p.project_type, p.company_id,
             c.name AS company_name, u.full_name AS lead_name,
             p.start_date::text AS start_date, p.due_date::text AS due_date,
             p.archived_at::text AS archived_at,
             -- Asked here so the page can say WHY delete will be refused,
             -- rather than offering it and letting the database explain.
             (SELECT count(*)::int FROM message m JOIN thread t2 ON t2.id = m.thread_id
               WHERE t2.project_id = p.id) AS message_count
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
             s.full_name AS completed_by_name,
             (SELECT count(*)::int FROM task c
               WHERE c.parent_id = t.id AND c.status <> 'completed') AS open_children
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
      sql`SELECT id, full_name FROM app.team_directory
           -- is_person is the one definition of who can be given work: the
           -- retired agent service accounts own historical rows and can never
           -- be given any. See migration 0062.
           WHERE is_active AND is_person ORDER BY full_name`,
    );
    const comments = await tx.execute<CommentItem & { [k: string]: unknown }>(sql`
      SELECT id, author_name, author_id, body, created_at::text
        FROM comment WHERE entity_type = 'project' AND entity_id = ${id}
       ORDER BY created_at
    `);
    return {
      record,
      tasks: tasks.rows as TaskItem[],
      team: members.rows,
      comments: comments.rows as CommentItem[],
    };
  });

  const files = await listAttachments('project', id);

  if (!data) notFound();
  const { record, tasks, team, comments } = data;

  const awaiting = tasks.filter((t) => t.status === 'submitted');
  const openTasks = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const completed = tasks.filter((t) => t.status === 'completed');

  return (
    <>
      <PageHeader eyebrow={record.company_name} title={record.name} />

      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <Field label="Status" value={PROJECT_STATUS_LABELS[record.status]} />
          <Field label="Type" value={PROJECT_TYPE_LABELS[record.project_type]} />
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
        {/*
          No role gate. Until 9A only a moderator could raise a task, which made
          the case this phase exists for impossible — an editor who needs a
          photo could not ask the designer for it. `task_insert` now admits any
          real person, and sign-off is untouched.
        */}
        <TaskForm action={createTaskAction.bind(null, record.id)} team={team} meId={me.id} />
      </Section>

      <Section title={`Discussion — ${comments.length}`}>
        <Comments
          items={comments}
          addAction={addCommentAction.bind(null, 'project', record.id, `/projects/${record.id}`)}
          deleteAction={deleteCommentAction.bind(null, `/projects/${record.id}`)}
          currentUserId={me.id}
          canModerate={canModerate}
        />
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
      {/* Briefs, storyboards, delivered cuts — the working files for this job. */}
      <Section title={`Files — ${files.length}`}>
        <Attachments
          action={uploadAttachmentAction.bind(null, 'project', id, `/projects/${id}`)}
          items={files.map((f) => ({
            id: f.id,
            originalName: f.originalName,
            mimeType: f.mimeType,
            sizeBytes: String(f.sizeBytes),
            caption: f.caption,
            uploaderName: null,
            createdAt: String(f.createdAt),
          }))}
          revalidate={`/projects/${id}`}
        />
      </Section>

      {/* --- Taking it out of use: moderators, name must be typed ------------- */}
      {canModerate && (
        <Section title={record.archived_at ? 'Archived' : 'Archive or delete'}>
          {record.archived_at ? (
            <>
              <p className="prose-vixart" style={{ opacity: 0.68 }}>
                This project is out of use. Its tasks, files and conversation are
                kept, and it no longer appears in pickers or on the schedule.
              </p>
              <form action={setProjectArchivedAction} className="mt-4">
                <input type="hidden" name="projectId" value={record.id} />
                <input type="hidden" name="archived" value="0" />
                <button type="submit" className="btn btn-inverse">Bring it back</button>
              </form>
            </>
          ) : (
            <>
              <p className="prose-vixart" style={{ opacity: 0.68 }}>
                Archiving keeps everything and takes the project out of every picker.
                That is almost always what you want on a delivered job: what was said
                and what was made stay where they are.
              </p>
              <form action={setProjectArchivedAction} className="mt-4">
                <input type="hidden" name="projectId" value={record.id} />
                <input type="hidden" name="archived" value="1" />
                <button type="submit" className="btn">Archive this project</button>
              </form>
            </>
          )}

          <p className="prose-vixart mt-8" style={{ opacity: 0.68 }}>
            {record.message_count > 0 ? (
              <>
                This project cannot be deleted: its channel holds{' '}
                {record.message_count} message(s), and deleting it would remove the
                conversation. Archive it instead.
              </>
            ) : (
              <>
                Deleting also removes its {tasks.length} task(s) and cannot be undone.
                It is refused outright once anybody has said something in its channel.
              </>
            )}
          </p>
          {record.message_count === 0 && (
            <form action={deleteProjectAction} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="projectId" value={record.id} />
              <input type="hidden" name="expected" value={record.name} />
              <label className="block" htmlFor="confirmation">
                <span className="label block" style={{ opacity: 0.68 }}>
                  Type “{record.name}” to confirm
                </span>
                <input
                  id="confirmation"
                  name="confirmation"
                  required
                  autoComplete="off"
                  className="mt-1.5 w-72 border border-void bg-pure px-3 py-2.5 text-[15px] focus:border-[3px] focus:px-[10px] focus:py-[8px] focus:outline-none"
                />
              </label>
              <button type="submit" className="btn">
                Delete permanently
              </button>
            </form>
          )}
        </Section>
      )}

    </>
  );
}

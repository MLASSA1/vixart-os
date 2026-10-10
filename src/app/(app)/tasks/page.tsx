import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { TaskRow, type TaskItem } from '@/components/TaskRow';
import { withUser } from '@/db/session';
import { capped, QUERY_CAP } from '@/lib/list-caps';
import { createTaskAction } from './actions';
import { TaskForm } from './TaskForm';

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
       -- No WHERE on status: all of it, finished included, because Amin asked
       -- for every completed task to be reachable. The ORDER BY below puts
       -- finished work last, so the LIMIT trims that tail first and never
       -- crowds out anything still live.
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

  /*
   * EVERY TASK APPEARS EXACTLY ONCE.
   *
   * This is the reorganisation, and the reason it was needed is arithmetic.
   * There are 130 open tasks, 126 of them with no project, and Amin raised 127
   * — so the old sections "Raised by me", "Internal" and "The team's work" were
   * each showing him the SAME 126 tasks, every one truncated at 25 with "101
   * more not shown". Three near-identical lists, none of them complete, and the
   * same task met three times on the way down the page. That is what "so messy"
   * was.
   *
   * The sections below partition the work: a task is either finished, or
   * nobody's, or yours, or one particular person's. No task is in two of them,
   * so the page is as long as the work is and no longer.
   *
   * "Internal" is gone as a section. With 126 of 130 tasks having no project it
   * is not a category, it is the norm — and a section for the norm is a second
   * copy of the page. The project is shown on the row when there is one.
   */
  const open = rows.filter((t) => t.status !== 'completed');
  const done = rows.filter((t) => t.status === 'completed');

  const mine = open.filter((t) => t.assignee_id === me.id);
  const unowned = open.filter((t) => t.assignee_id === null);

  /*
   * Somebody else's open work.
   *
   * For a MEMBER this is exactly what they asked a colleague for — 0075 lets
   * them see their own work and what they raised, so anything here assigned to
   * another person is by definition a request of theirs. No filter on
   * `created_by_id` is needed and none is written: the policy already said it.
   *
   * For MANAGEMENT it is the board, and it is grouped by person below rather
   * than piled into one list of 128.
   */
  const others = open.filter((t) => t.assignee_id !== null && t.assignee_id !== me.id);

  /*
   * One block per person, busiest first.
   *
   * By person because that is the question a manager has in front of 130 tasks
   * — not "what is outstanding" but "who is carrying what". Busiest first
   * because the answer is usually at that end: Adam has 46 and Mohamed Amine
   * has 2, and a page that opened alphabetically would bury that.
   */
  const today = new Date().toISOString().slice(0, 10);
  const byPerson = canModerate
    ? [...new Map(others.map((t) => [t.assignee_id!, t.assignee_name ?? 'Unknown'])).entries()]
        .map(([id, name]) => {
          const theirs = others.filter((t) => t.assignee_id === id);
          return {
            id,
            name,
            tasks: theirs,
            overdue: theirs.filter((t) => t.due_date !== null && t.due_date < today).length,
          };
        })
        .sort((a, b) => b.tasks.length - a.tasks.length || a.name.localeCompare(b.name))
    : [];

  return (
    <>
      <PageHeader eyebrow="Work" title="Tasks" />

      <p className="prose-vixart" style={{ opacity: 0.7 }}>
        {canModerate
          ? 'Everybody\u2019s work, grouped by who is carrying it. Whoever a task is assigned to moves it along and says when it is finished — you and Mohamed Amine are told when that happens.'
          : 'Your work, and anything you have asked somebody else for. You move your own tasks along and say when they are finished; Amin and Mohamed Amine are told.'}
      </p>

      {/*
        The form, closed.
        
        It was an open section at the top, so the page began with a form and the
        work started below the fold. Raising a task is the occasional act; the
        reason to open this page is to look at what is already here.
      */}
      <Section title="Raise a task">
        <details>
          <summary className="cursor-pointer text-[14px] font-medium select-none">
            New task
          </summary>
          <div className="mt-4">
            <TaskForm
              action={createTaskAction.bind(null, null)}
              team={team}
              meId={me.id}
              projects={projects}
            />
          </div>
        </details>
      </Section>

      {/* ---- nobody's, and therefore first ------------------------------- */}
      {unowned.length > 0 && (
        <Section title={`Nobody is doing these — ${unowned.length}`}>
          <p className="hint mb-3">
            Raised and never given to anybody. Nothing happens until somebody is
            named.
          </p>
          <ul className="border-t border-void/10">
            {capped(unowned).shown.map((t) => (
              <TaskRow key={t.id} task={t} canModerate={canModerate} showProject />
            ))}
          </ul>
          {capped(unowned).hidden > 0 && (
            <p className="hint mt-3">{capped(unowned).hidden} more not shown.</p>
          )}
        </Section>
      )}

      {/* ---- yours ------------------------------------------------------- */}
      <Section title={`Your work — ${mine.length}`}>
        {mine.length === 0 ? (
          <Empty message="Nothing assigned to you." />
        ) : (
          <>
            <ul className="border-t border-void/10">
              {capped(mine).shown.map((t) => (
                <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
              ))}
            </ul>
            {capped(mine).hidden > 0 && (
              <p className="hint mt-3">{capped(mine).hidden} more not shown.</p>
            )}
          </>
        )}
      </Section>

      {/* ---- what a member asked somebody else for ----------------------- */}
      {!canModerate && others.length > 0 && (
        <Section title={`You asked for — ${others.length}`}>
          <p className="hint mb-3">
            Work you raised for somebody else. You cannot move it — they do — and
            you are told when it is finished.
          </p>
          <ul className="border-t border-void/10">
            {capped(others).shown.map((t) => (
              <TaskRow key={t.id} task={t} canModerate={canModerate} showProject />
            ))}
          </ul>
          {capped(others).hidden > 0 && (
            <p className="hint mt-3">{capped(others).hidden} more not shown.</p>
          )}
        </Section>
      )}

      {/* ---- the board, by person ---------------------------------------- */}
      {byPerson.length > 0 && (
        <Section title={`The team\u2019s work — ${others.length}`}>
          <p className="hint mb-4">
            One block each, busiest first. Collapse anybody you are not looking
            at. Only you and Mohamed Amine see this.
          </p>
          <div className="grid gap-2">
            {byPerson.map((person) => (
              <details key={person.id} open className="border-t border-void/10 pt-2">
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 py-1 select-none">
                  <span className="font-semibold">{person.name}</span>
                  <span className="hint">
                    {person.tasks.length} open
                    {person.overdue > 0 && (
                      <span className="tone-danger ml-2 rounded-[6px] px-1.5 py-0.5 font-semibold">
                        {person.overdue} overdue
                      </span>
                    )}
                  </span>
                </summary>
                <ul className="mt-1 border-t border-void/10">
                  {capped(person.tasks).shown.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      canModerate={canModerate}
                      showProject
                    />
                  ))}
                </ul>
                {capped(person.tasks).hidden > 0 && (
                  <p className="hint mt-2 mb-3">
                    {capped(person.tasks).hidden} more not shown.
                  </p>
                )}
              </details>
            ))}
          </div>
        </Section>
      )}

      {/* ---- finished, closed, at the bottom ----------------------------- */}
      {done.length > 0 && (
        <Section title={`Finished — ${done.length}`}>
          <details>
            <summary className="cursor-pointer text-[14px] font-medium select-none">
              Show finished work
            </summary>
            <p className="hint mt-3 mb-3">
              All of it, not the last thirty days — Amin asked for every completed
              task to be reachable.
            </p>
            <ul className="border-t border-void/10">
              {capped(done).shown.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  isMine={t.assignee_id === me.id}
                  canModerate={canModerate}
                  showProject
                />
              ))}
            </ul>
            {capped(done).hidden > 0 && (
              <p className="hint mt-3">{capped(done).hidden} more not shown.</p>
            )}
          </details>
        </Section>
      )}
    </>
  );
}

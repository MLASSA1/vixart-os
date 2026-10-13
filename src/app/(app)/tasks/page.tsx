import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { TaskRow, type TaskItem } from '@/components/TaskRow';
import { withUser } from '@/db/session';
import { today } from '@/lib/calendar';
import { QUERY_CAP } from '@/lib/list-caps';
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
       /*
        * NUMERIC ORDER, because the titles are a numbered plan.
        *
        * This ordered by status, then priority, then due date, then
        * created_at DESC — and for a numbered plan that is close to the worst
        * order there is. created_at DESC reverses it (01, 02, 03 is read back
        * 20, 19, 18), priority cuts it into bands so Task 05 falls below Task
        * 20, and the title tie-break was lexicographic, which puts "TASK 10"
        * before "TASK 2".
        *
        * app.task_sort_key (0076) is the one definition of task order: the
        * prefix as written, then the first number padded so text order IS
        * numeric order, then the title as a stable tie-break. Three pages order
        * tasks and a copied regex is three chances to differ.
        *
        * Completed last so the LIMIT trims finished work before anything live.
        */
       ORDER BY (t.status = 'completed'), app.task_sort_key(t.title), t.id
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
   * EVERY TASK APPEARS EXACTLY ONCE, AND NOTHING IS HIDDEN.
   *
   * Two complaints, one shape. The first was that three sections each showed the
   * same 126 tasks truncated at 25 — fixed by partitioning the work so a task is
   * finished, or nobody's, or yours, or one particular person's, never two of
   * those.
   *
   * The second: "there some task are hiden tell a memebre complte one then
   * anotheres aprears". That is SECTION_CAP. Adam has 46 open tasks and saw 25;
   * finishing one revealed the 26th. From the inside that does not look like a
   * cap, it looks like the system is drip-feeding work — and there is no way to
   * plan a week you cannot see.
   *
   * So nothing on this page is capped per section any more. The rail is the
   * query's own LIMIT, which is the honest place for it, and if that ever bites
   * the page says so out loud rather than quietly showing less.
   */
  const open = rows.filter((t) => t.status !== 'completed');

  /*
   * NEW, IN PROGRESS, FINISHED — asked for in those words.
   *
   * "We need a place where user can see his completed tasks and where are not
   * completed and are the new ones."
   *
   * `todo` is work nobody has picked up — that is "new". Everything between
   * being picked up and being finished is "in progress", and that includes the
   * two legacy `submitted` rows and any `blocked` one: from the reader's side
   * they are all the same thing, work under way, and the status chip on the row
   * says which. Three groups, not six, because the question is which pile a task
   * is in.
   */
  const isNew = (t: TaskItem) => t.status === 'todo';
  const groupOf = (list: TaskItem[]) => ({
    fresh: list.filter(isNew),
    doing: list.filter((t) => !isNew(t)),
  });

  const mineAll = rows.filter((t) => t.assignee_id === me.id);
  const mine = groupOf(mineAll.filter((t) => t.status !== 'completed'));
  const mineDone = mineAll.filter((t) => t.status === 'completed');

  const unowned = open.filter((t) => t.assignee_id === null);

  /*
   * Somebody else's work.
   *
   * For a MEMBER this is exactly what they asked a colleague for — 0075 lets
   * them see their own work and what they raised, so anything here assigned to
   * another person is by definition a request of theirs. No filter on
   * created_by_id is needed and none is written: the policy already said it.
   *
   * For MANAGEMENT it is the board, grouped by person below.
   */
  const others = open.filter((t) => t.assignee_id !== null && t.assignee_id !== me.id);
  const othersDone = rows.filter(
    (t) => t.status === 'completed' && t.assignee_id !== null && t.assignee_id !== me.id,
  );

  /*
   * One block per person, busiest first.
   *
   * By person because that is the question a manager has in front of 130 tasks —
   * not "what is outstanding" but "who is carrying what". Busiest first because
   * the answer is usually at that end: alphabetical would open with Abdelkbir's
   * 7 and bury Azzedine's 18 overdue.
   *
   * The summary line carries the new/in-progress split so a manager gets it
   * without three sub-lists per person.
   */
  /*
   * The LOCAL day, from the one helper that knows what that means.
   *
   * This was `new Date().toISOString().slice(0, 10)` — the UTC date. Morocco is
   * UTC+1 all year, so for the first hour of every day this returned yesterday
   * and the per-person "N overdue" counts disagreed with Needs attention, which
   * asks Postgres for `current_date`, and with the row's own "— overdue".
   */
  const todayYmd = today();
  const byPerson = canModerate
    ? [...new Map(others.map((t) => [t.assignee_id, t.assignee_name ?? 'Unknown'])).entries()]
        .map(([id, name]) => {
          const theirs = others.filter((t) => t.assignee_id === id);
          return {
            id,
            name,
            tasks: theirs,
            fresh: theirs.filter(isNew).length,
            doing: theirs.filter((t) => !isNew(t)).length,
            overdue: theirs.filter((t) => t.due_date !== null && t.due_date < todayYmd).length,
          };
        })
        .sort((a, b) => b.tasks.length - a.tasks.length || a.name.localeCompare(b.name))
    : [];

  /*
   * Said out loud when the LIMIT bit.
   *
   * The counts on this page are computed from the rows that came back, so a
   * truncated query would make every heading understate by an unknown amount —
   * a page confidently reporting "34 in progress" when it is 60. 141 tasks
   * against a 300 limit leaves headroom today; the day it does not, the reader
   * is told rather than misled.
   */
  const truncated = rows.length >= QUERY_CAP;

  const Rows = ({
    list,
    isMineList = false,
  }: {
    list: TaskItem[];
    isMineList?: boolean;
  }) => (
    <ul className="border-t border-void/10">
      {list.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          isMine={isMineList || t.assignee_id === me.id}
          canModerate={canModerate}
          showProject
        />
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader eyebrow="Work" title="Tasks" />

      <p className="prose-vixart" style={{ opacity: 0.7 }}>
        {canModerate
          ? 'Everybody\u2019s work, grouped by who is carrying it. Whoever a task is assigned to moves it along and says when it is finished — you and Mohamed Amine are told when that happens.'
          : 'Your work, and anything you have asked somebody else for. You move your own tasks along and say when they are finished; Amin and Mohamed Amine are told.'}
      </p>

      {truncated && (
        <p className="tone-warn mt-4 rounded-[10px] px-4 py-3 text-[14px]">
          This page is showing the first {QUERY_CAP} tasks and there are more. The
          counts below are of what is shown, not of everything — tell me and I
          will add paging.
        </p>
      )}

      {/*
        The form, closed. The page used to open with it, so the work started
        below the fold, and raising a task is the occasional act.
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
          <Rows list={unowned} />
        </Section>
      )}

      {/* ---- your own work, in three piles -------------------------------- */}
      <Section title={`Your work — ${mine.fresh.length + mine.doing.length} open`}>
        {mine.fresh.length === 0 && mine.doing.length === 0 && mineDone.length === 0 ? (
          <Empty message="Nothing assigned to you." />
        ) : (
          <>
            <h3 className="label mt-1">New — {mine.fresh.length}</h3>
            {mine.fresh.length === 0 ? (
              <p className="hint mt-1 mb-4">Nothing new. Everything you have has been started.</p>
            ) : (
              <>
                <p className="hint mt-1 mb-2">
                  Not picked up yet. Press Accepted when you take one on.
                </p>
                <Rows list={mine.fresh} isMineList />
              </>
            )}

            <h3 className="label mt-7">In progress — {mine.doing.length}</h3>
            {mine.doing.length === 0 ? (
              <p className="hint mt-1 mb-4">Nothing under way.</p>
            ) : (
              <div className="mt-2">
                <Rows list={mine.doing} isMineList />
              </div>
            )}

            {mineDone.length > 0 && (
              <details className="mt-7">
                <summary className="label cursor-pointer select-none">
                  Finished — {mineDone.length}
                </summary>
                <p className="hint mt-2 mb-2">
                  All of it, not the last thirty days.
                </p>
                <Rows list={mineDone} isMineList />
              </details>
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
          <Rows list={others} />
        </Section>
      )}

      {/* ---- the board, by person ---------------------------------------- */}
      {byPerson.length > 0 && (
        <Section title={`The team\u2019s work — ${others.length} open`}>
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
                    {person.fresh} new · {person.doing} in progress
                    {person.overdue > 0 && (
                      <span className="tone-danger ml-2 rounded-[6px] px-1.5 py-0.5 font-semibold">
                        {person.overdue} overdue
                      </span>
                    )}
                  </span>
                </summary>
                <div className="mt-1">
                  <Rows list={person.tasks} />
                </div>
              </details>
            ))}
          </div>
        </Section>
      )}

      {/*
        ---- finished work that somebody else did -------------------------

        NOT GATED ON canModerate ANY MORE, and the gate was losing work.

        Amin asked that "complted tast need to be showen all of them". A member
        raises a task for a colleague; the colleague finishes it; it left "You
        asked for" (which is open work only) and this section was the only other
        place it could appear — closed to members. So the one person who most
        wanted to know it was done was the one person who could not see it, on
        the page built to answer exactly that.

        The rows are the same rows for everybody: `task_select` (0075) returns a
        member only what they are assigned or raised, so a member sees the work
        they asked for and a moderator sees the team's. Only the heading has to
        say which, because only the heading knows.
      */}
      {othersDone.length > 0 && (
        <Section
          title={
            canModerate
              ? `Finished by the team — ${othersDone.length}`
              : `Finished, that you asked for — ${othersDone.length}`
          }
        >
          <details>
            <summary className="cursor-pointer text-[14px] font-medium select-none">
              Show finished work
            </summary>
            <div className="mt-3">
              <Rows list={othersDone} />
            </div>
          </details>
        </Section>
      )}
    </>
  );
}

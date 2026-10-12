import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { TaskRow, type TaskItem } from '@/components/TaskRow';
import { withUser } from '@/db/session';
import { QUERY_CAP } from '@/lib/list-caps';

export const dynamic = 'force-dynamic';

/**
 * My work — what this person owes, and nothing else.
 *
 * The landing page for a team member: their open tasks, the projects they are
 * on, and anything they have asked somebody else for. Since 0075 it is also the
 * whole of what they can see — a member's task list is their own.
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
       WHERE (t.assignee_id = ${me.id}
          -- Raised by me and carried by somebody else: I need to see it, and
          -- especially to see it stuck.
          OR t.created_by_id = ${me.id}
          -- Waiting on my sign-off. Only a moderator can act on these, and the
          -- section is hidden for everyone else.
          OR (t.status = 'submitted' AND ${canModerate})
       )
       -- Finished work is kept, all of it: the ORDER BY puts it last so the
       -- LIMIT trims that tail before anything still live.
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
       ORDER BY (t.status = 'completed'), app.task_sort_key(t.title)
       LIMIT ${QUERY_CAP}
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
  /*
   * The same two piles as /tasks, from the same definition of "new".
   *
   * `todo` is work nobody has picked up. Everything else that is not finished is
   * under way — including a legacy `blocked` or `submitted` row, because from the
   * reader's side those are all the same thing and the chip on the row says
   * which. Two piles, not six.
   */
  const fresh = mine.filter((t) => t.status === 'todo');
  const doing = mine.filter((t) => t.status !== 'todo');
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
          <p className="label">Finished</p>
          <p className="kpi mt-1">{done.length}</p>
        </div>
      </div>

      {/*
        NEW AND IN PROGRESS, SEPARATELY, AND NOTHING HELD BACK.
        
        Two complaints met here. "There some task are hiden tell a memebre
        complte one then anotheres aprears" was SECTION_CAP: Adam has 46 and saw
        25, and finishing one revealed the 26th — which from the inside looks
        like the system drip-feeding work rather than a cap, and you cannot plan
        a week you cannot see. Nothing on this page is capped per section now;
        the query's LIMIT is the rail and it says so when it bites.
        
        And "we need palce where user can see his complted taska and where are
        not completd and are the new ones" — so: not picked up, under way,
        finished. `todo` is new; everything between being picked up and being
        finished is in progress, and the chip on the row says which.
      */}
      <Section title={`Your work — ${mine.length}`}>
        {mine.length === 0 ? (
          <Empty message="Nothing assigned. Anyone can raise a task — including you, for yourself." />
        ) : (
          <>
            <h3 className="label mt-1">New — {fresh.length}</h3>
            {fresh.length === 0 ? (
              <p className="hint mt-1 mb-4">
                Nothing new — everything you have has been started.
              </p>
            ) : (
              <>
                <p className="hint mt-1 mb-2">
                  Not picked up yet. Press Accepted when you take one on.
                </p>
                <ul className="border-t border-void/10">
                  {fresh.map((t) => (
                    <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
                  ))}
                </ul>
              </>
            )}

            <h3 className="label mt-7">In progress — {doing.length}</h3>
            {doing.length === 0 ? (
              <p className="hint mt-1 mb-4">Nothing under way.</p>
            ) : (
              <ul className="mt-2 border-t border-void/10">
                {doing.map((t) => (
                  <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
                ))}
              </ul>
            )}
          </>
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
              ? 'Submitted under the old rule, before the three buttons. Nothing enters this state any more — move them along and the section goes.'
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
        <Section title={`Finished — ${done.length}`}>
          <details>
            <summary className="cursor-pointer text-[14px] font-medium select-none">
              Show finished work
            </summary>
            <p className="hint mt-2 mb-2">All of it, not the last thirty days.</p>
            <ul className="border-t border-void/10">
              {done.map((t) => (
                <TaskRow key={t.id} task={t} isMine canModerate={canModerate} showProject />
              ))}
            </ul>
          </details>
        </Section>
      )}
    </>
  );
}

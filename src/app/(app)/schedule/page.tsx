import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import {
  addDays, addMonths, dayLabel, dayNumber, isWeekend, monthGrid, monthLabel,
  startOfMonth, startOfWeek, today, weekDays, type Ymd,
} from '@/lib/calendar';
import { addScheduleEntryAction, deleteScheduleEntryAction } from './actions';
import { ScheduleForm } from './ScheduleForm';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  shoot: 'Shoot', meeting: 'Meeting', off: 'Off', block: 'Focus',
};
const KIND_TONE: Record<string, string> = {
  shoot: 'tone-accent', meeting: 'tone-quiet', off: 'tone-warn', block: 'tone-quiet',
};

interface Entry {
  [k: string]: unknown;
  id: string; title: string; kind: string;
  starts_on: string; ends_on: string | null; note: string | null;
}
interface DueTask {
  [k: string]: unknown;
  id: string; title: string; status: string; due_date: string;
  project_name: string | null; assignee_name: string | null; assignee_id: string;
}

/**
 * My schedule — a view over work that already exists, plus what is not work.
 *
 * Tasks are not copied here. They appear on their due date because this reads
 * the task table; re-entering them would create a second place where work
 * lives and a second place to forget to update it.
 *
 * Moderators additionally get the team's week: every person's tasks side by
 * side. That is a capacity view — it exists so nobody is handed a fifth job on
 * a day they already have four — and it deliberately shows NO personal
 * entries. Whether somebody has booked Thursday off is theirs to say.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; team?: string }>;
}) {
  const session = await auth();
  const me = session!.user;
  const canModerate = me.role === 'admin' || me.role === 'moderator';

  const params = await searchParams;
  const view = params.view === 'month' || params.view === 'day' ? params.view : 'week';
  const anchor: Ymd = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : today();
  const teamView = canModerate && params.team === '1';

  const days: Ymd[] =
    view === 'day' ? [anchor] : view === 'month' ? monthGrid(anchor) : weekDays(anchor);
  const from = days[0]!;
  const to = days[days.length - 1]!;

  const { entries, tasks, people } = await withUser(async (tx) => {
    // RLS returns only this person's rows; no user filter is written here,
    // because a filter in a query is a second copy of a rule the policy owns.
    const e = await tx.execute<Entry>(sql`
      SELECT id, title, kind, starts_on::text, ends_on::text, note
        FROM schedule_entry
       WHERE starts_on <= ${to}::date
         AND coalesce(ends_on, starts_on) >= ${from}::date
       ORDER BY starts_on, title
    `);

    const t = await tx.execute<DueTask>(sql`
      SELECT t.id, t.title, t.status, t.due_date::text,
             p.name AS project_name, a.full_name AS assignee_name, t.assignee_id
        FROM task t
        LEFT JOIN project p ON p.id = t.project_id
        LEFT JOIN app_user a ON a.id = t.assignee_id
       WHERE t.due_date BETWEEN ${from}::date AND ${to}::date
         AND t.status <> 'completed'
         AND (${teamView} OR t.assignee_id = ${me.id})
       ORDER BY t.due_date, t.title
    `);

    const u = teamView
      ? (
          await tx.execute<{ id: string; full_name: string }>(sql`
            SELECT id, full_name FROM app.team_directory
             -- A column for an account nobody signs in as is a column of
             -- permanent blanks.
             WHERE is_active AND is_person ORDER BY full_name
          `)
        ).rows
      : [];

    return { entries: e.rows, tasks: t.rows, people: u };
  });

  const entriesOn = (d: Ymd) =>
    entries.filter((x) => x.starts_on <= d && (x.ends_on ?? x.starts_on) >= d);
  const tasksOn = (d: Ymd, who?: string) =>
    tasks.filter((x) => x.due_date === d && (!who || x.assignee_id === who));

  const step = view === 'month' ? addMonths(anchor, 1) : addDays(anchor, view === 'day' ? 1 : 7);
  const back = view === 'month' ? addMonths(anchor, -1) : addDays(anchor, view === 'day' ? -1 : -7);
  const href = (d: Ymd, v = view, t = teamView) =>
    `/schedule?view=${v}&date=${d}${t ? '&team=1' : ''}`;

  const title =
    view === 'month' ? monthLabel(anchor)
    : view === 'day' ? dayLabel(anchor)
    : `${dayLabel(days[0]!)} — ${dayLabel(days[6]!)}`;

  return (
    <>
      <PageHeader eyebrow={teamView ? 'Capacity' : (me.name ?? 'Me')} title="Schedule" />

      <div className="flex flex-wrap items-center gap-2 border-b border-void/15 pb-4">
        {(['day', 'week', 'month'] as const).map((v) => (
          <Link key={v} href={href(anchor, v)}
                className={`btn btn-small ${view === v ? '' : 'btn-inverse'}`}>
            {v[0]!.toUpperCase() + v.slice(1)}
          </Link>
        ))}
        <span className="mx-2 font-semibold">{title}</span>
        <Link href={href(back)} className="btn btn-inverse btn-small">←</Link>
        <Link href={href(today())} className="btn btn-inverse btn-small">Today</Link>
        <Link href={href(step)} className="btn btn-inverse btn-small">→</Link>
        {canModerate && (
          <Link href={href(anchor, view, !teamView)}
                className={`btn btn-small ml-auto ${teamView ? '' : 'btn-inverse'}`}>
            {teamView ? 'My schedule' : 'Team week'}
          </Link>
        )}
      </div>

      {teamView ? (
        <Section title="The team, by day">
          <p className="hint mb-3">
            Tasks only, so nobody is given a fifth job on a day they already have
            four. Personal entries are not shown — whether somebody has booked a
            day off is theirs to say.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-[13.5px]">
              <thead>
                <tr>
                  <th className="th border-b border-void/15 py-2 text-left">Person</th>
                  {weekDays(anchor).map((d) => (
                    <th key={d} className={`th border-b border-void/15 py-2 text-left ${isWeekend(d) ? 'opacity-45' : ''}`}>
                      {dayLabel(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td className="border-b border-void/10 py-2 pr-3 font-medium">{p.full_name}</td>
                    {weekDays(anchor).map((d) => {
                      const n = tasksOn(d, p.id);
                      return (
                        <td key={d} className="border-b border-void/10 py-2 pr-3 align-top">
                          {n.length === 0 ? (
                            <span className="opacity-25">·</span>
                          ) : (
                            <span className={`chip ${n.length >= 4 ? 'tone-danger' : 'tone-quiet'}`}>
                              {n.length}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : (
        <>
          <Section title={view === 'month' ? 'The month' : view === 'day' ? 'The day' : 'The week'}>
            <div className={view === 'month' ? 'grid grid-cols-7 gap-px bg-void/10' : 'space-y-3'}>
              {days.map((d) => {
                const dayEntries = entriesOn(d);
                const dayTasks = tasksOn(d);
                const isToday = d === today();
                const outside = view === 'month' && d.slice(0, 7) !== startOfMonth(anchor).slice(0, 7);

                return (
                  <div key={d}
                       className={`${view === 'month' ? 'min-h-24 bg-surface p-1.5' : 'card px-4 py-3'} ${
                         outside ? 'opacity-40' : ''} ${isWeekend(d) ? 'bg-void/[0.02]' : ''}`}>
                    <p className={`label ${isToday ? 'text-accent font-bold' : ''}`}>
                      {view === 'month' ? dayNumber(d) : dayLabel(d)}
                      {isToday && view !== 'month' && ' · today'}
                    </p>

                    {dayTasks.map((t) => (
                      <p key={t.id} className="mt-1 truncate text-[12.5px]">
                        <span className="chip tone-quiet mr-1">Task</span>
                        {t.title}
                        {t.project_name && <span className="hint"> · {t.project_name}</span>}
                      </p>
                    ))}

                    {dayEntries.map((e) => (
                      <p key={e.id} className="mt-1 flex items-center gap-1.5 text-[12.5px]">
                        <span className={`chip ${KIND_TONE[e.kind] ?? 'tone-quiet'}`}>
                          {KIND_LABEL[e.kind] ?? e.kind}
                        </span>
                        <span className="min-w-0 truncate">{e.title}</span>
                        {view !== 'month' && (
                          <form action={deleteScheduleEntryAction} className="ml-auto">
                            <input type="hidden" name="entryId" value={e.id} />
                            <button type="submit"
                                    className="cursor-pointer text-[11.5px] text-void/40 hover:text-void hover:underline">
                              Remove
                            </button>
                          </form>
                        )}
                      </p>
                    ))}

                    {view !== 'month' && dayTasks.length === 0 && dayEntries.length === 0 && (
                      <p className="hint mt-1 text-[12.5px]">Nothing.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Add to my week">
            <ScheduleForm action={addScheduleEntryAction} defaultDate={anchor} />
          </Section>
        </>
      )}
    </>
  );
}

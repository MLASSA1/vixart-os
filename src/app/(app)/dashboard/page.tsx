import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { PageHeader, Section, Empty } from '@/components/ui';
import { Stage } from '@/components/CompanyTable';
import { withUser } from '@/db/session';
import { formatMAD } from '@/lib/money';
import { formatDate, since } from '@/lib/format';
import { TASK_STATUS_LABELS } from '@/lib/labels';
import { ActivityFeed, type ActivityItem } from '@/components/ActivityFeed';

export const dynamic = 'force-dynamic';

interface Counts {
  [k: string]: unknown;
  companies: string;
  clients: string;
  leads: string;
  contacts: string;
  active_projects: string;
  open_tasks: string;
  awaiting_signoff: string;
  overdue_tasks: string;
}

/**
 * Dashboard.
 *
 * Monk Mode: one engagement at a time, so the active client is the headline and
 * everything else is secondary. Money figures are only queried for management
 * and the work moderator — a member's session would be refused by the deal
 * policy anyway, so the query is not even attempted.
 */
export default async function DashboardPage() {
  const session = await auth();
  const me = session!.user;
  const seesMoney = me.role === 'admin' || me.role === 'moderator';

  const data = await withUser(async (tx) => {
    const counts = await tx.execute<Counts>(sql`
      SELECT (SELECT count(*)::text FROM company)                                   AS companies,
             (SELECT count(*)::text FROM company
               WHERE relationship='client' AND status='client')                     AS clients,
             (SELECT count(*)::text FROM company
               WHERE relationship='client' AND status IN ('lead','prospect'))       AS leads,
             (SELECT count(*)::text FROM contact)                                   AS contacts,
             (SELECT count(*)::text FROM project WHERE status='active')             AS active_projects,
             (SELECT count(*)::text FROM task WHERE status IN ('todo','in_progress')) AS open_tasks,
             (SELECT count(*)::text FROM task WHERE status='submitted')             AS awaiting_signoff,
             (SELECT count(*)::text FROM task
               WHERE status IN ('todo','in_progress')
                 AND due_date IS NOT NULL AND due_date < current_date)              AS overdue_tasks
    `);

    const activeClients = await tx.execute<{
      [k: string]: unknown;
      id: string; name: string; status: string; engagement_summary: string | null;
      last_contact: string | null; open_tasks: string;
    }>(sql`
      SELECT c.id, c.name, c.status::text AS status, c.engagement_summary,
             (SELECT max(i.occurred_at) FROM interaction i WHERE i.company_id=c.id) AS last_contact,
             (SELECT count(*)::text FROM task t
                JOIN project p ON p.id=t.project_id
               WHERE p.company_id=c.id AND t.status IN ('todo','in_progress')) AS open_tasks
        FROM company c
       WHERE c.relationship='client' AND c.status='client'
       ORDER BY lower(c.name)
    `);

    const myTasks = await tx.execute<{
      [k: string]: unknown;
      id: string; title: string; status: string; due_date: string | null;
      project_id: string; project_name: string;
    }>(sql`
      SELECT t.id, t.title, t.status, t.due_date::text AS due_date,
             t.project_id, p.name AS project_name
        FROM task t JOIN project p ON p.id=t.project_id
       WHERE t.assignee_id = ${me.id} AND t.status IN ('todo','in_progress')
       ORDER BY t.due_date NULLS LAST LIMIT 6
    `);

    let money = { open_value: 0n, weighted: 0n, won_value: 0n, open_deals: 0 };
    if (seesMoney) {
      const d = await tx.execute<{
        [k: string]: unknown;
        open_value: string; weighted: string; won_value: string; open_deals: string;
      }>(sql`
        SELECT coalesce(sum(value_centimes) FILTER (WHERE stage IN ('proposal','negotiation')),0)::text AS open_value,
               coalesce(sum(value_centimes * probability / 100) FILTER (WHERE stage IN ('proposal','negotiation')),0)::text AS weighted,
               coalesce(sum(value_centimes) FILTER (WHERE stage='won'),0)::text AS won_value,
               count(*) FILTER (WHERE stage IN ('proposal','negotiation'))::text AS open_deals
          FROM deal
      `);
      const r = d.rows[0];
      money = {
        open_value: BigInt(r?.open_value ?? '0'),
        weighted: BigInt(r?.weighted ?? '0'),
        won_value: BigInt(r?.won_value ?? '0'),
        open_deals: Number(r?.open_deals ?? 0),
      };
    }

    const feed = await tx.execute<ActivityItem & { [k: string]: unknown }>(sql`
      SELECT id, actor_name, entity_type, entity_label, action, created_at::text
        FROM activity ORDER BY created_at DESC LIMIT 12
    `);

    return {
      counts: counts.rows[0]!,
      activeClients: activeClients.rows,
      myTasks: myTasks.rows,
      activity: feed.rows as ActivityItem[],
      money,
    };
  });

  const { counts, activeClients, myTasks, activity, money } = data;

  return (
    <>
      <PageHeader eyebrow={`Signed in as ${me.name}`} title="Dashboard" />

      {/* --- Headline figures ------------------------------------------------ */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="card px-5 py-4">
          <p className="label">Paying clients</p>
          <p className="kpi mt-1">{counts.clients}</p>
          <Link href="/clients" className="hint underline underline-offset-4">
            View
          </Link>
        </div>
        <div className="card px-5 py-4">
          <p className="label">Open leads</p>
          <p className="kpi mt-1">{counts.leads}</p>
          <Link href="/leads" className="hint underline underline-offset-4">
            View
          </Link>
        </div>
        <div className="card px-5 py-4">
          <p className="label">Active projects</p>
          <p className="kpi mt-1">{counts.active_projects}</p>
          <Link href="/projects" className="hint underline underline-offset-4">
            View
          </Link>
        </div>
        <div className="card px-5 py-4">
          <p className="label">Open tasks</p>
          <p className="kpi mt-1">{counts.open_tasks}</p>
          <p className="hint">
            {counts.overdue_tasks} overdue · {counts.awaiting_signoff} awaiting sign-off
          </p>
        </div>
      </div>

      {seesMoney && (
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="card px-5 py-4">
            <p className="label">Open deals</p>
            <p className="kpi mt-1">{money.open_deals}</p>
          </div>
          <div className="card px-5 py-4">
            <p className="label">Pipeline value</p>
            <p className="kpi mt-1">{formatMAD(money.open_value)}</p>
          </div>
          <div className="card px-5 py-4">
            <p className="label">Weighted forecast</p>
            <p className="kpi mt-1">{formatMAD(money.weighted)}</p>
          </div>
          <div className="card px-5 py-4">
            <p className="label">Won to date</p>
            <p className="kpi mt-1">{formatMAD(money.won_value)}</p>
            <p className="hint">Signed, not yet invoiced.</p>
          </div>
        </div>
      )}

      {/* --- Active engagements: the Monk Mode headline ---------------------- */}
      <Section title={`Active engagements — ${activeClients.length}`}>
        {activeClients.length === 0 ? (
          <Empty message="No active client" />
        ) : (
          <ul className="border-t border-void/10">
            {activeClients.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-void/10 py-3.5"
              >
                <div className="min-w-0">
                  <Link
                    href={`/companies/${c.id}`}
                    className="text-lg font-semibold underline-offset-4 hover:underline"
                  >
                    {c.name}
                  </Link>
                  {c.engagement_summary && (
                    <p className="hint mt-0.5 max-w-xl">{c.engagement_summary}</p>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <span className="hint">{c.open_tasks} open task(s)</span>
                  <span className="hint">last contact {since(c.last_contact)}</span>
                  <Stage value={c.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* --- What I owe ------------------------------------------------------ */}
      <Section title="My next tasks" action={<Link href="/my-work" className="hint underline underline-offset-4">All my work</Link>}>
        {myTasks.length === 0 ? (
          <Empty message="Nothing assigned to you right now" />
        ) : (
          <ul className="border-t border-void/10">
            {myTasks.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-baseline justify-between gap-4 border-b border-void/10 py-3"
              >
                <div>
                  <span className="font-medium">{t.title}</span>
                  <p className="hint">
                    <Link
                      href={`/projects/${t.project_id}`}
                      className="underline underline-offset-4"
                    >
                      {t.project_name}
                    </Link>
                  </p>
                </div>
                <span className="hint whitespace-nowrap">
                  {TASK_STATUS_LABELS[t.status]}
                  {t.due_date ? ` · due ${formatDate(t.due_date)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Team activity">
        <ActivityFeed items={activity} />
        <p className="hint mt-3">
          Recorded by the database itself when something changes, not by the screen
          that changed it — so nothing can be done without leaving a trace.
        </p>
      </Section>

      <Section title="Directory">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          <div className="card px-5 py-4">
            <p className="label">Client records</p>
            <p className="figure mt-1 text-xl">{counts.companies}</p>
          </div>
          <div className="card px-5 py-4">
            <p className="label">Contacts</p>
            <p className="figure mt-1 text-xl">{counts.contacts}</p>
          </div>
        </div>
      </Section>
    </>
  );
}

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
import { MonthlyBars, fillMonths } from '@/components/MonthlyBars';

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
             (SELECT count(*)::text FROM task WHERE status NOT IN ('submitted','completed')) AS open_tasks,
             (SELECT count(*)::text FROM task WHERE status='submitted')             AS awaiting_signoff,
             (SELECT count(*)::text FROM task
               WHERE status NOT IN ('submitted','completed')
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
                LEFT JOIN project p ON p.id=t.project_id
               WHERE p.company_id=c.id AND t.status NOT IN ('submitted','completed')) AS open_tasks
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
        FROM task t LEFT JOIN project p ON p.id=t.project_id
       WHERE t.assignee_id = ${me.id} AND t.status NOT IN ('submitted','completed')
       ORDER BY t.due_date NULLS LAST, app.task_sort_key(t.title), t.id LIMIT 6
    `);

    let money = { open_value: 0n, weighted: 0n, won_value: 0n, open_deals: 0 };
    // Recurring revenue, and the part of it that is at risk. A retainer whose
    // client nobody has spoken to in a month is the one that does not renew.
    let recurring = { mrr: 0n, active: 0, at_risk: 0 };
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
      const rec = await tx.execute<{
        [k: string]: unknown; mrr: string; active: string; at_risk: string;
      }>(sql`
        SELECT coalesce(sum(r.monthly_centimes),0)::text AS mrr,
               count(*)::text AS active,
               count(*) FILTER (
                 WHERE NOT EXISTS (
                   SELECT 1 FROM interaction i
                    WHERE i.company_id = r.company_id
                      AND i.occurred_at > now() - interval '30 days')
               )::text AS at_risk
          FROM retainer r
         WHERE r.status = 'active'
      `);
      const rr = rec.rows[0];
      recurring = {
        mrr: BigInt(rr?.mrr ?? '0'),
        active: Number(rr?.active ?? 0),
        at_risk: Number(rr?.at_risk ?? 0),
      };

      const r = d.rows[0];
      money = {
        open_value: BigInt(r?.open_value ?? '0'),
        weighted: BigInt(r?.weighted ?? '0'),
        won_value: BigInt(r?.won_value ?? '0'),
        open_deals: Number(r?.open_deals ?? 0),
      };
    }

    /*
     * Growth, month by month.
     *
     * One query per shape rather than one clever one: these are different
     * tables with different date columns, and a UNION that lines them up reads
     * worse than four plain selects and is no faster.
     *
     * Grouped by the expression rather than by an alias or an ordinal, because
     * inside a UNION branch `GROUP BY m` is ambiguous and `GROUP BY 2` is a
     * position nobody reading this would check.
     */
    const monthly = await tx.execute<{ kind: string; m: string; v: string }>(sql`
      SELECT 'clients' AS kind, to_char(created_at, 'YYYY-MM') AS m, count(*)::text AS v
        FROM company WHERE relationship = 'client'
       GROUP BY to_char(created_at, 'YYYY-MM')
      UNION ALL
      SELECT 'projects', to_char(created_at, 'YYYY-MM'), count(*)::text
        FROM project GROUP BY to_char(created_at, 'YYYY-MM')
      UNION ALL
      SELECT 'raised', to_char(created_at, 'YYYY-MM'), count(*)::text
        FROM task GROUP BY to_char(created_at, 'YYYY-MM')
      UNION ALL
      SELECT 'done', to_char(completed_at, 'YYYY-MM'), count(*)::text
        FROM task WHERE completed_at IS NOT NULL
       GROUP BY to_char(completed_at, 'YYYY-MM')
    `);

    /*
     * The money series, admin only, in DIRHAMS rather than centimes.
     *
     * A chart is read at a glance and a bar is a few pixels either way, so the
     * sub-dirham precision the rest of the system guards so carefully buys
     * nothing here. The figures beside and beneath the chart are the exact
     * ones; this is the shape.
     */
    let moneyMonthly: { kind: string; m: string; v: string }[] = [];
    if (seesMoney) {
      const mm = await tx.execute<{ kind: string; m: string; v: string }>(sql`
        SELECT 'won' AS kind, to_char(closed_at, 'YYYY-MM') AS m,
               (sum(value_centimes) / 100)::text AS v
          FROM deal WHERE stage = 'won' AND closed_at IS NOT NULL
         GROUP BY to_char(closed_at, 'YYYY-MM')
        UNION ALL
        SELECT 'billed', to_char(issue_date, 'YYYY-MM'),
               (sum(total_incl_vat) / 100)::text
          FROM document
         WHERE status <> 'brouillon' AND doc_type = 'facture' AND issue_date IS NOT NULL
         GROUP BY to_char(issue_date, 'YYYY-MM')
      `);
      moneyMonthly = mm.rows;
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
      recurring,
      monthly: monthly.rows,
      moneyMonthly,
    };
  });

  const {
    counts, activeClients, myTasks, activity, money, recurring, monthly, moneyMonthly,
  } = data;

  /*
   * The series, pulled out of the flat rows and padded to a continuous run of
   * months up to this one. `fillMonths` is what makes a month with nothing in
   * it show as an empty slot instead of vanishing — the month nobody won
   * anything is the most informative bar on a growth chart.
   */
  const thisMonth = new Date().toISOString().slice(0, 7);
  const series = (rows: { kind: string; m: string; v: string }[], kind: string) =>
    fillMonths(
      rows.filter((r) => r.kind === kind && r.m).map((r) => ({ month: r.m, value: Number(r.v) })),
      thisMonth,
    );

  const raised = series(monthly, 'raised');
  const done = series(monthly, 'done');
  // One ceiling across both, so the two charts can be compared by eye. Two
  // measures of the same unit on one axis would be a dual-axis chart; two
  // charts on a shared scale is the honest version of the same comparison.
  const taskCeiling = Math.max(0, ...raised.map((p) => p.value), ...done.map((p) => p.value));

  const clients = series(monthly, 'clients');
  const projects = series(monthly, 'projects');

  const won = series(moneyMonthly, 'won');
  const billed = series(moneyMonthly, 'billed');
  const wonTotal = won.reduce((a, p) => a + p.value, 0);
  const billedTotal = billed.reduce((a, p) => a + p.value, 0);

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
            <p className="label">Monthly recurring</p>
            <p className="kpi mt-1">{formatMAD(recurring.mrr)}</p>
            <p className="hint mt-1">
              {recurring.active} retainer{recurring.active === 1 ? '' : 's'}
              {recurring.at_risk > 0 ? ` · ${recurring.at_risk} gone quiet` : ''}
            </p>
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

      {/* --- Growth, month by month ------------------------------------------ */}
      <Section title="Growth, month by month">
        {seesMoney && (
          <>
            {/*
              THREE NUMBERS BEFORE ANY CHART, because the gap between the first
              two is the thing worth knowing and a chart would bury it. Work is
              won in one place and billed in another, and nothing in the system
              has been shouting when the second does not follow the first.
            */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="card px-4 py-3">
                <p className="label" style={{ opacity: 0.55 }}>Won</p>
                <p className="mt-1 text-[19px] font-bold tabular-nums">
                  {formatMAD(BigInt(Math.round(wonTotal)) * 100n)}
                </p>
              </div>
              <div className="card px-4 py-3">
                <p className="label" style={{ opacity: 0.55 }}>Invoiced</p>
                <p className="mt-1 text-[19px] font-bold tabular-nums">
                  {formatMAD(BigInt(Math.round(billedTotal)) * 100n)}
                </p>
              </div>
              <div className={`card px-4 py-3 ${wonTotal - billedTotal > 0 ? 'tone-warn' : ''}`}>
                <p className="label" style={{ opacity: 0.55 }}>Won but not invoiced</p>
                <p className="mt-1 text-[19px] font-bold tabular-nums">
                  {formatMAD(BigInt(Math.round(Math.max(0, wonTotal - billedTotal))) * 100n)}
                </p>
              </div>
            </div>

            {wonTotal > billedTotal && (
              <p className="hint mt-3">
                Work has been marked won that no invoice has followed. That is
                either billing still to do, or a deal marked won too early —
                both worth knowing before the month closes.
              </p>
            )}

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <MonthlyBars
                title="Deals won" points={won} money
                caption="by the month the deal was closed"
              />
              <MonthlyBars
                title="Invoiced" points={billed} money
                caption="issued invoices, VAT included"
              />
            </div>
          </>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MonthlyBars title="Clients added" points={clients} caption="new client records" />
          <MonthlyBars title="Projects started" points={projects} caption="by the month they were created" />
          {/*
            Raised and finished are the same unit, so they share a ceiling and
            can be read against each other. They are two charts rather than two
            series on one, which is the only way to compare them without a
            second y-axis — the fastest way there is to make a chart lie.
          */}
          <MonthlyBars
            title="Tasks raised" points={raised} scaleTo={taskCeiling}
            caption="what the team took on"
          />
          <MonthlyBars
            title="Tasks finished" points={done} scaleTo={taskCeiling}
            caption="same scale as raised, so the two compare"
          />
        </div>
      </Section>

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

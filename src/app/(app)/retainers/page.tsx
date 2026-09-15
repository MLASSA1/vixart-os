import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { formatMAD } from '@/lib/money';
import { formatDate } from '@/lib/format';
import {
  createRetainerAction,
  draftRetainerInvoicesAction,
  endRetainerAction,
  setRetainerStatusAction,
} from './actions';
import { EndRetainerForm, NewRetainerForm } from './RetainerForms';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string; label: string; status: string;
  company_id: string; company_name: string;
  monthly_centimes: string; billing_day: number;
  start_date: string; term_months: number; auto_renew: boolean;
  term_end: string; in_term: boolean; days_to_renewal: string;
  end_reason: string | null; ended_on: string | null;
  next_billing: string;
  drafted_this_period: string;
  last_contact: string | null;
}

/**
 * The monthly contracts.
 *
 * The column that earns its place is the term: a retainer inside its committed
 * term is money you can count on, and one on renewal is money that has to be
 * re-won. Those are different businesses and the screen should not show them
 * the same way.
 */
export default async function RetainersPage() {
  const session = await auth();
  const role = session?.user.role;
  if (role !== 'admin' && role !== 'moderator') redirect('/dashboard');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
  const period = today.slice(0, 7);

  const { rows, clients } = await withUser(async (tx) => {
    const list = await tx.execute<Row>(sql`
      SELECT r.id, r.label, r.status, r.company_id, c.name AS company_name,
             r.monthly_centimes::text, r.billing_day,
             r.start_date::text, r.term_months, r.auto_renew,
             r.end_reason, r.ended_on::text,

             app.retainer_term_end(r.start_date, r.term_months, r.auto_renew, r.end_date)::text
               AS term_end,
             app.retainer_in_committed_term(r.start_date, r.term_months) AS in_term,
             (app.retainer_term_end(r.start_date, r.term_months, r.auto_renew, r.end_date)
              - current_date)::text AS days_to_renewal,

             -- The next date this contract bills: this month if the day has not
             -- passed, otherwise next month.
             (CASE WHEN r.billing_day >= extract(day FROM current_date)
                   THEN make_date(extract(year FROM current_date)::int,
                                  extract(month FROM current_date)::int, r.billing_day)
                   ELSE (make_date(extract(year FROM current_date)::int,
                                   extract(month FROM current_date)::int, r.billing_day)
                         + interval '1 month')::date
              END)::text AS next_billing,

             (SELECT count(*)::text FROM document d
               WHERE d.retainer_id = r.id AND d.retainer_period = ${period}) AS drafted_this_period,

             (SELECT max(i.occurred_at)::date::text FROM interaction i
               WHERE i.company_id = r.company_id) AS last_contact
        FROM retainer r
        JOIN company c ON c.id = r.company_id
       ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                lower(c.name)
    `);

    const comps = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM company ORDER BY lower(name)
    `);

    return { rows: list.rows, clients: comps.rows };
  });

  const active = rows.filter((r) => r.status === 'active');
  const mrr = active.reduce<bigint>((a, r) => a + BigInt(r.monthly_centimes), 0n);

  // Inside the committed term the client cannot leave without breaking it.
  // On renewal they can simply not renew — which is when they are at risk.
  const committed = active.filter((r) => r.in_term);
  const onRenewal = active.filter((r) => !r.in_term);
  const committedValue = committed.reduce<bigint>((a, r) => a + BigInt(r.monthly_centimes), 0n);

  function card(r: Row) {
    const days = Number(r.days_to_renewal);
    const drafted = Number(r.drafted_this_period) > 0;
    const quiet =
      r.last_contact === null ||
      (Date.now() - new Date(r.last_contact).getTime()) / 86_400_000 > 30;

    return (
      <li key={r.id} className="card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="font-semibold">
              <Link href={`/companies/${r.company_id}`} className="underline-offset-4 hover:underline">
                {r.company_name}
              </Link>
              <span className="hint"> · {r.label}</span>
            </p>
            <p className="hint mt-0.5">
              Billed on the {r.billing_day} · since {formatDate(r.start_date)} ·{' '}
              {r.term_months}-month term{r.auto_renew ? ', renews' : ', does not renew'}
            </p>
          </div>
          <p className="code text-lg font-bold">{formatMAD(BigInt(r.monthly_centimes))}<span className="hint"> /mo</span></p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {r.status === 'active' ? (
            r.in_term ? (
              <span className="chip tone-ok">Committed to {formatDate(r.term_end)}</span>
            ) : (
              <span className={`chip ${days <= 30 ? 'tone-warn' : 'tone-quiet'}`}>
                On renewal · {days > 0 ? `${days} day${days === 1 ? '' : 's'} to ${formatDate(r.term_end)}` : 'term expired'}
              </span>
            )
          ) : r.status === 'paused' ? (
            <span className="chip tone-warn">Paused</span>
          ) : (
            <span className="chip tone-quiet">
              Ended {r.ended_on ? formatDate(r.ended_on) : ''}{r.end_reason ? ` — ${r.end_reason}` : ''}
            </span>
          )}

          {r.status === 'active' && (
            <>
              <span className={`chip ${drafted ? 'tone-ok' : 'tone-quiet'}`}>
                {drafted ? 'Drafted this month' : `Next bill ${formatDate(r.next_billing)}`}
              </span>
              {quiet && <span className="chip tone-danger">No contact in 30 days</span>}
            </>
          )}
        </div>

        {r.status !== 'ended' && (
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <form action={setRetainerStatusAction}>
              <input type="hidden" name="retainerId" value={r.id} />
              <input type="hidden" name="status" value={r.status === 'active' ? 'paused' : 'active'} />
              <button type="submit" className="hint cursor-pointer underline underline-offset-4">
                {r.status === 'active' ? 'Pause' : 'Resume'}
              </button>
            </form>
            <EndRetainerForm
              action={endRetainerAction}
              retainerId={r.id}
              label={r.label}
              inCommittedTerm={Boolean(r.in_term)}
              termEnds={formatDate(r.term_end)}
              today={today}
            />
          </div>
        )}
      </li>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Monthly contracts"
        title="Retainers"
        actions={
          <form action={draftRetainerInvoicesAction}>
            <button type="submit" className="btn btn-inverse btn-small">
              Draft this month now
            </button>
          </form>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="card px-5 py-4">
          <p className="label">Monthly recurring revenue</p>
          <p className="kpi mt-1">{formatMAD(mrr)}</p>
          <p className="hint mt-1">{active.length} active contract{active.length === 1 ? '' : 's'}</p>
        </div>
        <div className="card px-5 py-4">
          <p className="label">Committed</p>
          <p className="kpi mt-1">{formatMAD(committedValue)}</p>
          <p className="hint mt-1">
            {committed.length} inside their term
          </p>
        </div>
        <div className="card px-5 py-4">
          <p className="label">On renewal</p>
          <p className="kpi mt-1">{onRenewal.length}</p>
          <p className="hint mt-1">Has to be re-won, not assumed</p>
        </div>
        <div className="card px-5 py-4">
          <p className="label">Annualised</p>
          <p className="kpi mt-1">{formatMAD(mrr * 12n)}</p>
          <p className="hint mt-1">At today&apos;s rate</p>
        </div>
      </div>

      <Section title={`Contracts — ${rows.length}`}>
        {rows.length === 0 ? (
          <Empty message="No retainers yet. The first one is below." />
        ) : (
          <ul className="grid gap-3">{rows.map(card)}</ul>
        )}
      </Section>

      <Section title="Sign a client onto a retainer">
        <NewRetainerForm action={createRetainerAction} clients={clients} today={today} />
        <p className="hint mt-3">
          The monthly invoice is <strong>drafted</strong>, never issued. Issuing assigns
          the number and freezes the figures, and that stays yours to do.
        </p>
      </Section>
    </>
  );
}

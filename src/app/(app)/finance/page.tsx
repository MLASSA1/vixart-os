import Link from 'next/link';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { CATEGORY_LABELS, PAYMENT_METHOD_LABELS } from '@/lib/labels';
import { formatMAD } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { EntryForm } from './EntryForm';
import { RecurringForm } from './RecurringForm';
import {
  addEntryAction,
  addRecurringAction,
  deleteEntryAction,
  deleteRecurringAction,
  postDueNowAction,
  toggleRecurringAction,
} from './actions';
import { RECURRING_FREQUENCY_LABELS } from '@/lib/labels';

export const dynamic = 'force-dynamic';

interface EntryRow {
  [k: string]: unknown;
  id: string; direction: string; amount_centimes: string; vat_centimes: string;
  entry_date: string; category: string; payment_method: string;
  description: string | null; reference: string | null;
  company_name: string | null; is_automatic: boolean; recorded_by: string | null;
}

interface MonthRow {
  [k: string]: unknown;
  month: string; income: string; expense: string; profit: string;
}

interface CategoryRow {
  [k: string]: unknown;
  category: string; total: string;
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const session = await auth();
  // The brief is explicit: Amin alone. The RLS policy enforces it; this
  // redirect just avoids showing a signed-in member an empty screen.
  if (session?.user.role !== 'admin') redirect('/dashboard');

  const { year: yearParam } = await searchParams;
  const year = Number(yearParam) || new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);

  const data = await withUser(async (tx) => {
    const entries = await tx.execute<EntryRow>(sql`
      SELECT f.id, f.direction, f.amount_centimes::text, f.vat_centimes::text,
             f.entry_date::text, f.category, f.payment_method, f.description,
             f.reference, c.name AS company_name, f.is_automatic,
             u.full_name AS recorded_by
        FROM finance_entry f
        LEFT JOIN company c ON c.id = f.company_id
        LEFT JOIN app_user u ON u.id = f.recorded_by_id
       WHERE extract(year FROM f.entry_date) = ${year}
       ORDER BY f.entry_date DESC, f.created_at DESC
    `);

    const months = await tx.execute<MonthRow>(sql`
      SELECT to_char(date_trunc('month', entry_date), 'YYYY-MM') AS month,
             coalesce(sum(amount_centimes) FILTER (WHERE direction='income'), 0)::text  AS income,
             coalesce(sum(amount_centimes) FILTER (WHERE direction='expense'), 0)::text AS expense,
             (coalesce(sum(amount_centimes) FILTER (WHERE direction='income'), 0)
              - coalesce(sum(amount_centimes) FILTER (WHERE direction='expense'), 0))::text AS profit
        FROM finance_entry
       WHERE extract(year FROM entry_date) = ${year}
       GROUP BY 1 ORDER BY 1 DESC
    `);

    const byCategory = await tx.execute<CategoryRow>(sql`
      SELECT category, sum(amount_centimes)::text AS total
        FROM finance_entry
       WHERE direction = 'expense' AND extract(year FROM entry_date) = ${year}
       GROUP BY category ORDER BY sum(amount_centimes) DESC
    `);

    const years = await tx.execute<{ [k: string]: unknown; y: string }>(sql`
      SELECT DISTINCT extract(year FROM entry_date)::text AS y
        FROM finance_entry ORDER BY 1 DESC
    `);

    const outstanding = await tx.execute<{ [k: string]: unknown; total: string; n: string }>(sql`
      SELECT coalesce(sum(net_to_collect), 0)::text AS total, count(*)::text AS n
        FROM document WHERE doc_type = 'facture' AND status = 'emis'
    `);

    const comps = await tx.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM company ORDER BY lower(name)`,
    );

    // Recurring templates, with how many lines each has actually produced.
    const recurring = await tx.execute<{
      [k: string]: unknown;
      id: string; direction: string; description: string; category: string;
      amount_centimes: string; frequency: string; day_of_month: number;
      start_date: string; end_date: string | null; is_active: boolean;
      posted_count: string; last_period: string | null;
    }>(sql`
      SELECT r.id, r.direction, r.description, r.category,
             r.amount_centimes::text, r.frequency, r.day_of_month,
             r.start_date::text, r.end_date::text, r.is_active,
             (SELECT count(*)::text FROM finance_entry f
               WHERE f.recurring_entry_id = r.id) AS posted_count,
             (SELECT max(f.period_key) FROM finance_entry f
               WHERE f.recurring_entry_id = r.id) AS last_period
        FROM recurring_entry r
       ORDER BY r.is_active DESC, r.direction, lower(r.description)
    `);

    // What is owed to the tax authority: VAT charged on issued invoices, less
    // VAT paid on costs. Reads the frozen figures on the documents, never a
    // live rate.
    const vat = await tx.execute<{
      [k: string]: unknown;
      period: string; collected: string; paid: string;
    }>(sql`
      WITH collected AS (
        SELECT to_char(d.issue_date, 'YYYY-MM') AS period,
               sum(d.total_vat - d.withheld) AS amount
          FROM document d
         WHERE d.doc_type = 'facture' AND d.status IN ('emis','paye')
           AND extract(year FROM d.issue_date) = ${year}
         GROUP BY 1
      ),
      paid AS (
        SELECT to_char(f.entry_date, 'YYYY-MM') AS period,
               sum(f.vat_centimes) AS amount
          FROM finance_entry f
         WHERE f.direction = 'expense'
           AND extract(year FROM f.entry_date) = ${year}
         GROUP BY 1
      )
      -- FULL OUTER JOIN, not a correlated subquery hanging off document.
      -- Two reasons, and only the first one crashes:
      --
      --   1. PostgreSQL refuses a sublink that reads an ungrouped outer column,
      --      even when the expression around it is the GROUP BY key. GROUP BY 1
      --      names an output position; the check inside the sublink does not
      --      follow it back.
      --
      --   2. Anchoring on document means a month is only listed if it has an
      --      invoice in it. A month of costs with nothing invoiced would drop
      --      out of the VAT position silently — the worst kind of wrong, since
      --      the figure still looks complete. FULL OUTER keeps both sides.
      SELECT coalesce(c.period, p.period) AS period,
             coalesce(c.amount, 0)::text AS collected,
             coalesce(p.amount, 0)::text AS paid
        FROM collected c
        FULL OUTER JOIN paid p ON p.period = c.period
       ORDER BY 1 DESC
    `);

    // Issued, past its due date, still unpaid.
    const overdue = await tx.execute<{
      [k: string]: unknown;
      id: string; number: string; client: string; due_date: string;
      net_to_collect: string; days_late: string;
    }>(sql`
      SELECT d.id, d.number, coalesce(d.client_name, c.name) AS client,
             d.due_date::text, d.net_to_collect::text,
             (current_date - d.due_date)::text AS days_late
        FROM document d JOIN company c ON c.id = d.company_id
       WHERE d.doc_type = 'facture' AND d.status = 'emis'
         AND d.due_date IS NOT NULL AND d.due_date < current_date
       ORDER BY d.due_date
    `);

    return {
      entries: entries.rows,
      months: months.rows,
      byCategory: byCategory.rows,
      years: years.rows.map((r) => Number(r.y)),
      outstanding: {
        total: BigInt(outstanding.rows[0]?.total ?? '0'),
        count: Number(outstanding.rows[0]?.n ?? 0),
      },
      companies: comps.rows,
      recurring: recurring.rows,
      vat: vat.rows,
      overdue: overdue.rows,
    };
  });

  const income = data.entries
    .filter((e) => e.direction === 'income')
    .reduce<bigint>((a, e) => a + BigInt(e.amount_centimes), 0n);
  const expense = data.entries
    .filter((e) => e.direction === 'expense')
    .reduce<bigint>((a, e) => a + BigInt(e.amount_centimes), 0n);
  const profit = income - expense;

  const yearOptions = Array.from(
    new Set([...data.years, new Date().getFullYear(), year]),
  ).sort((a, b) => b - a);

  const biggest = data.byCategory.length
    ? BigInt(data.byCategory[0]!.total)
    : 1n;

  return (
    <>
      <PageHeader
        eyebrow="Management only"
        title="Finance"
        actions={
          <div className="flex gap-2">
            {yearOptions.map((y) => (
              <Link
                key={y}
                href={`/finance?year=${y}`}
                className={`btn btn-small ${y === year ? '' : 'btn-inverse'}`}
              >
                {y}
              </Link>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Money in — {year}</p>
          <p className="kpi mt-1">{formatMAD(income)}</p>
        </div>
        <div>
          <p className="label">Money out — {year}</p>
          <p className="kpi mt-1">{formatMAD(expense)}</p>
        </div>
        <div>
          <p className="label">Result</p>
          {/* Loss is stated in words and by the minus sign, never in red. */}
          <p className="kpi mt-1">{formatMAD(profit)}</p>
          <p className="hint mt-1">{profit < 0n ? 'Loss' : 'Profit'}</p>
        </div>
        <div>
          <p className="label">Awaiting payment</p>
          <p className="kpi mt-1">{formatMAD(data.outstanding.total)}</p>
          <p className="hint mt-1">
            {data.outstanding.count} invoice{data.outstanding.count === 1 ? '' : 's'} issued,
            not yet paid
          </p>
        </div>
      </div>

      <Section title={`Month by month — ${year}`}>
        {data.months.length === 0 ? (
          <Empty message="Nothing recorded this year" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Month</th>
                  <th className="th py-2 pr-4 text-right">In</th>
                  <th className="th py-2 pr-4 text-right">Out</th>
                  <th className="th py-2 text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => {
                  const p = BigInt(m.profit);
                  return (
                    <tr key={m.month} className="border-b border-void/10">
                      <td className="code py-2.5 pr-4">{m.month}</td>
                      <td className="code py-2.5 pr-4 text-right">
                        {formatMAD(BigInt(m.income))}
                      </td>
                      <td className="code py-2.5 pr-4 text-right">
                        {formatMAD(BigInt(m.expense))}
                      </td>
                      <td className="code py-2.5 text-right font-semibold">
                        {formatMAD(p)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-void">
                  <td className="py-2.5 pr-4 font-semibold">Year</td>
                  <td className="code py-2.5 pr-4 text-right font-semibold">
                    {formatMAD(income)}
                  </td>
                  <td className="code py-2.5 pr-4 text-right font-semibold">
                    {formatMAD(expense)}
                  </td>
                  <td className="code py-2.5 text-right font-bold">{formatMAD(profit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {data.byCategory.length > 0 && (
        <Section title="Where the money goes">
          <ul>
            {data.byCategory.map((c) => {
              const total = BigInt(c.total);
              const share = Number((total * 100n) / (biggest === 0n ? 1n : biggest));
              return (
                <li key={c.category} className="border-b border-void/10 py-2.5">
                  <div className="flex items-baseline justify-between gap-4">
                    <span>{CATEGORY_LABELS[c.category] ?? c.category}</span>
                    <span className="code">{formatMAD(total)}</span>
                  </div>
                  {/* Achromatic bar: proportion of the largest cost. */}
                  <span
                    aria-hidden="true"
                    className="mt-1 block h-1.5 border border-void/25"
                  >
                    <span
                      className="block h-full bg-void"
                      style={{ width: `${Math.max(share, 2)}%` }}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title={`Ledger — ${data.entries.length} movement(s)`}>
        {data.entries.length === 0 ? (
          <Empty message="Nothing recorded yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Date</th>
                  <th className="th py-2 pr-4">Description</th>
                  <th className="th py-2 pr-4">Category</th>
                  <th className="th py-2 pr-4">Paid by</th>
                  <th className="th py-2 pr-4 text-right">In</th>
                  <th className="th py-2 pr-4 text-right">Out</th>
                  <th className="th py-2"></th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => {
                  const amount = BigInt(e.amount_centimes);
                  return (
                    <tr key={e.id} className="border-b border-void/10 align-top">
                      <td className="code py-2.5 pr-4 whitespace-nowrap">
                        {formatDate(e.entry_date)}
                      </td>
                      <td className="py-2.5 pr-4">
                        {e.description ?? '—'}
                        <p className="hint">
                          {e.company_name ? `${e.company_name} · ` : ''}
                          {e.reference ?? ''}
                          {e.is_automatic ? ' · posted automatically' : ''}
                        </p>
                      </td>
                      <td className="hint py-2.5 pr-4">
                        {CATEGORY_LABELS[e.category] ?? e.category}
                      </td>
                      <td className="hint py-2.5 pr-4">
                        {PAYMENT_METHOD_LABELS[e.payment_method] ?? e.payment_method}
                      </td>
                      <td className="code py-2.5 pr-4 text-right whitespace-nowrap">
                        {e.direction === 'income' ? formatMAD(amount) : ''}
                      </td>
                      <td className="code py-2.5 pr-4 text-right whitespace-nowrap">
                        {e.direction === 'expense' ? formatMAD(amount) : ''}
                      </td>
                      <td className="py-2.5 text-right">
                        {e.is_automatic ? (
                          <span className="hint">from invoice</span>
                        ) : (
                          <form action={deleteEntryAction}>
                            <input type="hidden" name="entryId" value={e.id} />
                            <button
                              type="submit"
                              className="hint cursor-pointer underline underline-offset-4"
                            >
                              Delete
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Export for the accountant">
        <p className="prose-vixart" style={{ opacity: 0.7 }}>
          UTF-8 with a byte-order mark and semicolon separators, so Excel opens
          them correctly with accents intact. Amounts are plain decimals, so the
          columns can be summed.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a href="/api/export/finance" className="btn">Ledger (CSV)</a>
          <a href="/api/export/documents" className="btn btn-inverse">Issued documents (CSV)</a>
          <a href="/api/export/contacts" className="btn btn-inverse">Contacts (CSV)</a>
        </div>
      </Section>

      {/* --- Who has not paid ------------------------------------------- */}
      {data.overdue.length > 0 && (
        <Section title={`Overdue — ${data.overdue.length}`}>
          <p className="prose-vixart mb-4" style={{ opacity: 0.7 }}>
            Issued, past the due date, still unpaid. Chasing these is usually
            worth more than any cost you could cut.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Invoice</th>
                  <th className="th py-2 pr-4">Client</th>
                  <th className="th py-2 pr-4">Was due</th>
                  <th className="th py-2 pr-4">Late by</th>
                  <th className="th py-2 text-right">Owed</th>
                </tr>
              </thead>
              <tbody>
                {data.overdue.map((o) => (
                  <tr key={o.id} className="border-b border-void/10">
                    <td className="py-2.5 pr-4">
                      <Link href={`/documents/${o.id}`} className="code underline underline-offset-4">
                        {o.number}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4">{o.client}</td>
                    <td className="code py-2.5 pr-4">{formatDate(o.due_date)}</td>
                    {/* Lateness in words and weight, never in red. */}
                    <td className="py-2.5 pr-4 font-semibold">{o.days_late} days</td>
                    <td className="code py-2.5 text-right font-semibold">
                      {formatMAD(BigInt(o.net_to_collect))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* --- VAT position -------------------------------------------------- */}
      {data.vat.length > 0 && (
        <Section title={`VAT position — ${year}`}>
          <p className="prose-vixart mb-4" style={{ opacity: 0.7 }}>
            VAT charged on issued invoices, less the VAT contained in costs. A
            positive figure is roughly what is owed to the tax authority for that
            month. Read from the figures frozen on each document, never from a
            live rate — and it is an indication for your accountant, not a return.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Month</th>
                  <th className="th py-2 pr-4 text-right">Charged</th>
                  <th className="th py-2 pr-4 text-right">Paid on costs</th>
                  <th className="th py-2 text-right">Net position</th>
                </tr>
              </thead>
              <tbody>
                {data.vat.map((v) => {
                  const net = BigInt(v.collected) - BigInt(v.paid);
                  return (
                    <tr key={v.period} className="border-b border-void/10">
                      <td className="code py-2.5 pr-4">{v.period}</td>
                      <td className="code py-2.5 pr-4 text-right">
                        {formatMAD(BigInt(v.collected))}
                      </td>
                      <td className="code py-2.5 pr-4 text-right">
                        {formatMAD(BigInt(v.paid))}
                      </td>
                      <td className="code py-2.5 text-right font-semibold">
                        {formatMAD(net)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* --- Recurring costs ------------------------------------------------ */}
      <Section
        title={`Recurring — ${data.recurring.length}`}
        action={
          <form action={postDueNowAction}>
            <button type="submit" className="btn btn-small btn-inverse">
              Post anything due now
            </button>
          </form>
        }
      >
        <p className="prose-vixart mb-4" style={{ opacity: 0.7 }}>
          Rent, electricity, subscriptions — the costs that are the same figure
          every month. These post themselves each night, and catch up on every
          period missed if the stack was down. A period can only ever be posted
          once, so nothing is counted twice.
        </p>

        {data.recurring.length === 0 ? (
          <Empty message="Nothing recurring yet — add rent and the utility bills below and stop typing them" />
        ) : (
          <ul className="border-t border-void/10">
            {data.recurring.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-void/10 py-3"
              >
                <div className="min-w-0">
                  <span className={`font-semibold ${r.is_active ? '' : 'opacity-50 line-through'}`}>
                    {r.description}
                  </span>
                  <span className="hint ml-3">
                    {CATEGORY_LABELS[r.category] ?? r.category} ·{' '}
                    {RECURRING_FREQUENCY_LABELS[r.frequency] ?? r.frequency} · day{' '}
                    {r.day_of_month}
                  </span>
                  <p className="hint">
                    {r.posted_count} posted
                    {r.last_period ? ` · last ${r.last_period}` : ' · nothing yet'}
                    {r.end_date ? ` · ends ${formatDate(r.end_date)}` : ''}
                    {!r.is_active ? ' · stopped' : ''}
                  </p>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="code font-semibold">
                    {r.direction === 'expense' ? '− ' : ''}
                    {formatMAD(BigInt(r.amount_centimes))}
                  </span>
                  <form action={toggleRecurringAction}>
                    <input type="hidden" name="recurringId" value={r.id} />
                    <input type="hidden" name="active" value={r.is_active ? 'false' : 'true'} />
                    <button type="submit" className="hint cursor-pointer underline underline-offset-4">
                      {r.is_active ? 'Stop' : 'Restart'}
                    </button>
                  </form>
                  {/* Once it has posted, the lines are a record of money that
                      moved — so it is stopped, not erased. The database
                      refuses the delete either way. */}
                  {Number(r.posted_count) === 0 && (
                    <form action={deleteRecurringAction}>
                      <input type="hidden" name="recurringId" value={r.id} />
                      <button type="submit" className="hint cursor-pointer underline underline-offset-4">
                        Delete
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6">
          <RecurringForm action={addRecurringAction} today={today} />
        </div>
      </Section>

      <Section title="Record a movement">
        <EntryForm action={addEntryAction} companies={data.companies} today={today} />
      </Section>
    </>
  );
}

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
import { addEntryAction, deleteEntryAction } from './actions';

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

      <Section title="Record a movement">
        <EntryForm action={addEntryAction} companies={data.companies} today={today} />
      </Section>
    </>
  );
}

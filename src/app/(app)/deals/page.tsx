import { redirect } from 'next/navigation';
import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { DEAL_STAGE_LABELS } from '@/lib/labels';
import { formatMAD } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { DealForm } from './DealForm';
import { saveDealAction, setDealStageAction } from './actions';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string;
  title: string;
  company_id: string;
  company_name: string;
  value_centimes: bigint;
  stage: string;
  probability: number;
  expected_close_date: string | null;
  lost_reason: string | null;
  owner_name: string | null;
}

/** Stage tones: talking is quiet, closing is violet, won is green. */
const STAGE_STYLE: Record<string, string> = {
  proposal: 'tone-quiet',
  negotiation: 'tone-accent',
  won: 'tone-ok',
  lost: 'tone-quiet line-through opacity-70',
};

export default async function DealsPage() {
  const session = await auth();
  // Deals carry money. Members are kept out of prices and totals, and the RLS
  // policy would return nothing anyway — redirect rather than show a blank page.
  if (session?.user.role === 'member') redirect('/my-work');

  const { rows, companies } = await withUser(async (tx) => {
    const deals = await tx.execute<Row>(sql`
      SELECT d.id, d.title, d.company_id, c.name AS company_name,
             d.value_centimes, d.stage, d.probability,
             d.expected_close_date::text AS expected_close_date,
             d.lost_reason, u.full_name AS owner_name
        FROM deal d
        JOIN company c ON c.id = d.company_id
        LEFT JOIN app_user u ON u.id = d.owner_id
       ORDER BY CASE d.stage WHEN 'negotiation' THEN 0 WHEN 'proposal' THEN 1
                             WHEN 'won' THEN 2 ELSE 3 END,
                d.expected_close_date NULLS LAST, d.created_at DESC
    `);
    const comps = await tx.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM company ORDER BY lower(name)`,
    );
    return { rows: deals.rows, companies: comps.rows };
  });

  const open = rows.filter((r) => r.stage === 'proposal' || r.stage === 'negotiation');
  const won = rows.filter((r) => r.stage === 'won');

  const openValue = open.reduce<bigint>((a, r) => a + BigInt(r.value_centimes), 0n);
  // Weighted forecast: each open deal counted at its own confidence.
  const weighted = open.reduce<bigint>(
    (a, r) => a + (BigInt(r.value_centimes) * BigInt(r.probability)) / 100n,
    0n,
  );
  const wonValue = won.reduce<bigint>((a, r) => a + BigInt(r.value_centimes), 0n);

  return (
    <>
      <PageHeader eyebrow="Opportunities" title="Deals" />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Open</p>
          <p className="kpi mt-1">{open.length}</p>
        </div>
        <div>
          <p className="label">Open value</p>
          <p className="kpi mt-1">{formatMAD(openValue)}</p>
        </div>
        <div>
          <p className="label">Weighted forecast</p>
          <p className="kpi mt-1">{formatMAD(weighted)}</p>
          <p className="hint mt-1">Each deal at its own confidence.</p>
        </div>
        <div>
          <p className="label">Won</p>
          <p className="kpi mt-1">{formatMAD(wonValue)}</p>
        </div>
      </div>

      <Section title={`Pipeline — ${rows.length}`}>
        {rows.length === 0 ? (
          <Empty message="No opportunity recorded yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Opportunity</th>
                  <th className="th py-2 pr-4">Stage</th>
                  <th className="th py-2 pr-4 text-right">Value</th>
                  <th className="th py-2 pr-4 text-right">Confidence</th>
                  <th className="th py-2 pr-4">Expected</th>
                  <th className="th py-2">Move to</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-void/10 align-top">
                    <td className="py-3 pr-4">
                      <Link
                        href={`/deals/${row.id}`}
                        className="font-semibold underline-offset-4 hover:underline"
                      >
                        {row.title}
                      </Link>
                      <p className="hint mt-0.5">
                        <Link
                          href={`/companies/${row.company_id}`}
                          className="underline underline-offset-4"
                        >
                          {row.company_name}
                        </Link>
                        {row.owner_name ? ` · ${row.owner_name}` : ''}
                      </p>
                      {row.lost_reason && (
                        <p className="hint mt-0.5">Lost: {row.lost_reason}</p>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-block px-2 py-0.5 text-[12.5px] font-medium ${
                          STAGE_STYLE[row.stage]
                        }`}
                      >
                        {DEAL_STAGE_LABELS[row.stage]}
                      </span>
                    </td>
                    <td className="code py-3 pr-4 text-right whitespace-nowrap">
                      {formatMAD(BigInt(row.value_centimes))}
                    </td>
                    <td className="code py-3 pr-4 text-right">{row.probability} %</td>
                    <td className="hint py-3 pr-4 whitespace-nowrap">
                      {row.expected_close_date ? formatDate(row.expected_close_date) : '—'}
                    </td>
                    <td className="py-3">
                      {/* A closed deal gets NO one-click moves. The table
                          re-sorts after every change, so rows jump position —
                          and one stray click on a won deal was un-winning it
                          and dropping it from the totals. Reopening a closed
                          deal is a decision: it goes through the full form
                          below, never through a button that moves under the
                          cursor. */}
                      {row.stage === 'won' || row.stage === 'lost' ? (
                        <span className="hint">closed</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {['proposal', 'negotiation', 'won']
                            .filter((s) => s !== row.stage)
                            .map((s) => (
                              <form key={s} action={setDealStageAction}>
                                <input type="hidden" name="dealId" value={row.id} />
                                <input type="hidden" name="stage" value={s} />
                                <button type="submit" className="btn btn-inverse btn-small">
                                  {DEAL_STAGE_LABELS[s]}
                                </button>
                              </form>
                            ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Record an opportunity">
        <DealForm
          action={saveDealAction.bind(null, null)}
          companies={companies}
          submitLabel="Add deal"
        />
        <p className="hint mt-3">
          Marking a deal lost is done from this form, because the reason is required.
        </p>
      </Section>
    </>
  );
}

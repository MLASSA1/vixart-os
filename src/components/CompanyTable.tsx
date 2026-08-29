import Link from 'next/link';
import { Empty } from '@/components/ui';
import { COMPANY_STAGE_LABELS } from '@/lib/labels';
import { since } from '@/lib/format';

/**
 * The company table, shared by Companies / Clients / Leads.
 *
 * Those three pages are the same records under different filters, so they are
 * the same table too — one place to change a column, not three.
 */

export interface CompanyRow {
  id: string;
  name: string;
  status: string;
  relationship: string;
  city: string | null;
  engagement_summary: string | null;
  primary_contact: string | null;
  contact_count: string;
  open_deals?: string;
  last_contact: string | null;
}

/** Stage in tones: won is green, warming is violet, cold is quiet ink. */
const STAGE_STYLE: Record<string, string> = {
  client: 'tone-ok',
  prospect: 'tone-accent',
  lead: 'tone-quiet',
  dormant: 'tone-quiet opacity-70',
};

export function Stage({ value }: { value: string }) {
  return (
    <span className={`chip ${STAGE_STYLE[value] ?? STAGE_STYLE.lead}`}>
      {COMPANY_STAGE_LABELS[value] ?? value}
    </span>
  );
}

export function CompanyTable({
  rows,
  emptyMessage,
  action,
}: {
  rows: CompanyRow[];
  emptyMessage: string;
  action?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return <Empty message={emptyMessage} action={action} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b-2 border-void">
            <th className="th py-2 pr-4">Organisation</th>
            <th className="th py-2 pr-4">Stage</th>
            <th className="th py-2 pr-4">City</th>
            <th className="th py-2 pr-4">Main contact</th>
            <th className="th py-2 text-right">Last exchange</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-void/10 align-top">
              <td className="py-3 pr-4">
                <Link
                  href={`/companies/${row.id}`}
                  className="font-semibold underline-offset-4 hover:underline"
                >
                  {row.name}
                </Link>
                {row.engagement_summary && (
                  <p className="hint mt-0.5 max-w-md">{row.engagement_summary}</p>
                )}
              </td>
              <td className="py-3 pr-4">
                <Stage value={row.status} />
              </td>
              <td className="hint py-3 pr-4">{row.city ?? '—'}</td>
              <td className="py-3 pr-4 text-[14px]">
                {row.primary_contact ?? (
                  <span className="hint">
                    {Number(row.contact_count) > 0
                      ? `${row.contact_count} contact(s)`
                      : '—'}
                  </span>
                )}
              </td>
              <td className="hint py-3 text-right whitespace-nowrap">
                {since(row.last_contact)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

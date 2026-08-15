import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { ButtonLink, Empty, PageHeader, Status } from '@/components/ui';
import { withUser } from '@/db/session';
import { since } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Row {
  [column: string]: unknown;
  id: string;
  name: string;
  status: string;
  city: string | null;
  engagement_summary: string | null;
  primary_contact: string | null;
  contact_count: string;
  last_contact: string | null;
}

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'client', label: 'Clients' },
  { value: 'prospect', label: 'Prospects' },
  { value: 'lead', label: 'Leads' },
  { value: 'dormant', label: 'Dormant' },
] as const;

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const { status = '', q = '' } = await searchParams;
  const search = q.trim();

  const rows = await withUser(async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT c.id, c.name, c.status, c.city, c.engagement_summary,
             (SELECT ct.full_name FROM contact ct
               WHERE ct.client_id = c.id AND ct.is_primary LIMIT 1) AS primary_contact,
             (SELECT count(*)::text FROM contact ct WHERE ct.client_id = c.id) AS contact_count,
             (SELECT max(i.occurred_at) FROM interaction i WHERE i.client_id = c.id) AS last_contact
        FROM client c
       WHERE (${status} = '' OR c.status::text = ${status})
         AND (${search} = '' OR c.name ILIKE ${'%' + search + '%'}
                             OR coalesce(c.city, '') ILIKE ${'%' + search + '%'}
                             OR coalesce(c.engagement_summary, '') ILIKE ${'%' + search + '%'})
       ORDER BY CASE c.status
                  WHEN 'client' THEN 0 WHEN 'prospect' THEN 1
                  WHEN 'lead' THEN 2 ELSE 3 END,
                lower(c.name)
    `);
    return result.rows;
  });

  const counts = await withUser(async (tx) => {
    const result = await tx.execute<{ status: string; n: string }>(
      sql`SELECT status::text AS status, count(*)::text AS n FROM client GROUP BY status`,
    );
    return Object.fromEntries(result.rows.map((r) => [r.status, Number(r.n)]));
  });

  const total = Object.values(counts).reduce<number>((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        eyebrow="Pipeline"
        title="Clients"
        actions={<ButtonLink href="/clients/new">New record</ButtonLink>}
      />

      {/* Filters — the active one inverts, exactly like the sidebar. */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = status === f.value;
          const count = f.value === '' ? total : (counts[f.value] ?? 0);
          return (
            <Link
              key={f.value || 'all'}
              href={f.value ? `/clients?status=${f.value}` : '/clients'}
              className={`meta border border-void px-3 py-1.5 ${
                active ? 'bg-void text-pure' : 'hover:bg-void hover:text-pure'
              }`}
            >
              {f.label} <span className="numeral">{count}</span>
            </Link>
          );
        })}

        <form action="/clients" className="ml-auto flex items-center gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Search"
            aria-label="Search clients"
            className="w-44 border border-void bg-pure px-3 py-1.5 text-[15px] focus:border-[3px] focus:px-[10px] focus:py-[4px] focus:outline-none"
          />
          <button type="submit" className="btn btn-inverse">
            Find
          </button>
        </form>
      </div>

      {rows.length === 0 ? (
        <div className="mt-8">
          <Empty
            message={search ? `No record matches "${search}"` : 'No record in this stage'}
            action={<ButtonLink href="/clients/new">Create a record</ButtonLink>}
          />
        </div>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-void">
                <th className="meta py-2.5 pr-4">Client</th>
                <th className="meta py-2.5 pr-4">Stage</th>
                <th className="meta py-2.5 pr-4">City</th>
                <th className="meta py-2.5 pr-4">Contact</th>
                <th className="meta py-2.5 text-right">Last exchange</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-void/10 align-top">
                  <td className="py-3.5 pr-4">
                    <Link
                      href={`/clients/${row.id}`}
                      className="font-semibold underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.engagement_summary && (
                      <p
                        className="prose-vixart mt-0.5 text-[15px]"
                        style={{ opacity: 0.68 }}
                      >
                        {row.engagement_summary}
                      </p>
                    )}
                  </td>
                  <td className="py-3.5 pr-4">
                    <Status value={row.status} />
                  </td>
                  <td className="amount py-3.5 pr-4" style={{ opacity: 0.68 }}>
                    {row.city ?? '—'}
                  </td>
                  <td className="py-3.5 pr-4">
                    {row.primary_contact ? (
                      <span>{row.primary_contact}</span>
                    ) : (
                      <span style={{ opacity: 0.52 }}>
                        {Number(row.contact_count) > 0
                          ? `${row.contact_count} contact(s)`
                          : '—'}
                      </span>
                    )}
                  </td>
                  <td
                    className="amount py-3.5 text-right whitespace-nowrap"
                    style={{ opacity: row.last_contact ? 0.68 : 0.52 }}
                  >
                    {since(row.last_contact)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import { sql } from 'drizzle-orm';
import { ButtonLink, PageHeader } from '@/components/ui';
import { CompanyTable } from '@/components/CompanyTable';
import { listCompanies } from '@/lib/queries';
import { SearchBar } from '@/components/SearchBar';

export const dynamic = 'force-dynamic';

/** Leads — not yet won. Everything before the first invoice. */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = '' } = await searchParams;
  const rows = await listCompanies({
    where: sql`c.relationship = 'client' AND c.status IN ('lead', 'prospect')`,
    search: q,
  });

  return (
    <>
      <PageHeader
        eyebrow="Not yet won"
        title="Leads"
        actions={<ButtonLink href="/companies/new">New lead</ButtonLink>}
      />
      <SearchBar action="/leads" defaultValue={q} placeholder="Search leads" />
      <div className="mt-6">
        <CompanyTable
          rows={rows}
          emptyMessage={q ? `No lead matches "${q}"` : 'No open lead'}
          action={<ButtonLink href="/companies/new">Add a lead</ButtonLink>}
        />
      </div>
      <p className="hint mt-6">
        {rows.length} open. A lead becomes a client from its own record, once
        they are paying.
      </p>
    </>
  );
}

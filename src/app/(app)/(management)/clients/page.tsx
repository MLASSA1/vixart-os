import { sql } from 'drizzle-orm';
import { ButtonLink, PageHeader } from '@/components/ui';
import { CompanyTable } from '@/components/CompanyTable';
import { listCompanies } from '@/lib/queries';
import { SearchBar } from '@/components/SearchBar';

export const dynamic = 'force-dynamic';

/** Clients — organisations that are paying. A filtered view of `company`. */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = '' } = await searchParams;
  const rows = await listCompanies({
    where: sql`c.relationship = 'client' AND c.status = 'client'`,
    search: q,
  });

  return (
    <>
      <PageHeader
        eyebrow="Active business"
        title="Clients"
        actions={<ButtonLink href="/companies/new">New record</ButtonLink>}
      />
      <SearchBar action="/clients" defaultValue={q} placeholder="Search clients" />
      <div className="mt-6">
        <CompanyTable
          rows={rows}
          emptyMessage={q ? `No client matches "${q}"` : 'No paying client yet'}
        />
      </div>
      <p className="hint mt-6">
        {rows.length} paying client{rows.length === 1 ? '' : 's'}. Move a prospect here
        from its record once they are billable.
      </p>
    </>
  );
}

import { ButtonLink, PageHeader } from '@/components/ui';
import { CompanyTable } from '@/components/CompanyTable';
import { SearchBar } from '@/components/SearchBar';
import { listCompanies } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * All clients, at every stage — the full archive, dormant ones included.
 * Clients and Leads are filtered views of this same table. VIXART provides the
 * services, so there are no suppliers or vendors here: every record is a client.
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = '' } = await searchParams;
  const rows = await listCompanies({ search: q });

  return (
    <>
      <PageHeader
        eyebrow="Archive"
        title="All clients"
        actions={<ButtonLink href="/companies/new">New record</ButtonLink>}
      />
      <SearchBar action="/companies" defaultValue={q} placeholder="Search organisations" />
      <div className="mt-6">
        <CompanyTable
          rows={rows}
          emptyMessage={q ? `No organisation matches "${q}"` : 'No organisation recorded'}
          action={<ButtonLink href="/companies/new">Add one</ButtonLink>}
        />
      </div>
      <p className="hint mt-6">
        Every client on record, at any stage — including dormant ones kept as
        references. Clients and Leads are this same list, filtered.
      </p>
    </>
  );
}

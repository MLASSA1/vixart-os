import { ButtonLink, PageHeader } from '@/components/ui';
import { CompanyTable } from '@/components/CompanyTable';
import { SearchBar } from '@/components/SearchBar';
import { listCompanies } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Companies — every organisation VIXART deals with: clients, suppliers,
 * partners. Clients and Leads are filtered views of this same table.
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
        eyebrow="Directory"
        title="Companies"
        actions={<ButtonLink href="/companies/new">New record</ButtonLink>}
      />
      <SearchBar action="/companies" defaultValue={q} placeholder="Search organisations" />
      <div className="mt-6">
        <CompanyTable
          rows={rows}
          showRelationship
          emptyMessage={q ? `No organisation matches "${q}"` : 'No organisation recorded'}
          action={<ButtonLink href="/companies/new">Add one</ButtonLink>}
        />
      </div>
      <p className="hint mt-6">
        Every organisation, whatever the relationship. Clients and Leads show the
        same records filtered.
      </p>
    </>
  );
}

import { PageHeader } from '@/components/ui';
import { createCompanyAction } from '../actions';
import { CompanyForm } from '../CompanyForm';

export const dynamic = 'force-dynamic';

export default function NewClientPage() {
  return (
    <>
      <PageHeader eyebrow="Pipeline" title="New record" />
      <CompanyForm
        action={createCompanyAction}
        submitLabel="Create record"
        cancelHref="/clients"
      />
    </>
  );
}

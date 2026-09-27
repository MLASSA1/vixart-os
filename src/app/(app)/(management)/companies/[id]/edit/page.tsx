import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { company } from '@/db/schema';
import { withUser } from '@/db/session';
import { updateCompanyAction } from '../../actions';
import { CompanyForm } from '../../CompanyForm';

export const dynamic = 'force-dynamic';

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const record = await withUser(async (tx) => {
    const rows = await tx.select().from(company).where(eq(company.id, id)).limit(1);
    return rows[0];
  });

  if (!record) notFound();

  // `updateCompanyAction` takes the id first; bind it so the form only ever
  // supplies the fields, never the target record.
  const action = updateCompanyAction.bind(null, record.id);

  return (
    <>
      <PageHeader eyebrow={record.name} title="Edit record" />
      <CompanyForm
        action={action}
        record={record}
        submitLabel="Save changes"
        cancelHref={`/companies/${record.id}`}
      />
    </>
  );
}

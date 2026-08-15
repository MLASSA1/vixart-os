import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { client } from '@/db/schema';
import { withUser } from '@/db/session';
import { updateClientAction } from '../../actions';
import { ClientForm } from '../../ClientForm';

export const dynamic = 'force-dynamic';

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const record = await withUser(async (tx) => {
    const rows = await tx.select().from(client).where(eq(client.id, id)).limit(1);
    return rows[0];
  });

  if (!record) notFound();

  // `updateClientAction` takes the id first; bind it so the form only ever
  // supplies the fields, never the target record.
  const action = updateClientAction.bind(null, record.id);

  return (
    <>
      <PageHeader eyebrow={record.name} title="Edit record" />
      <ClientForm
        action={action}
        record={record}
        submitLabel="Save changes"
        cancelHref={`/clients/${record.id}`}
      />
    </>
  );
}

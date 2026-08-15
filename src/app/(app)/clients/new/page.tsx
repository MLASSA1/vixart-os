import { PageHeader } from '@/components/ui';
import { createClientAction } from '../actions';
import { ClientForm } from '../ClientForm';

export const dynamic = 'force-dynamic';

export default function NewClientPage() {
  return (
    <>
      <PageHeader eyebrow="Pipeline" title="New record" />
      <ClientForm
        action={createClientAction}
        submitLabel="Create record"
        cancelHref="/clients"
      />
    </>
  );
}

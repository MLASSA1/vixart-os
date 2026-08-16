'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextInput } from '@/components/ui';
import { DOCUMENT_TYPES } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Creating…' : 'Create draft'}
    </button>
  );
}

export function NewDocumentForm({
  action,
  companies,
  deals,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  companies: ReadonlyArray<{ id: string; name: string }>;
  deals: ReadonlyArray<{ id: string; label: string }>;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  return (
    <form action={formAction} className="border border-void/25 p-5">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <Select
          name="docType"
          label="Type"
          required
          defaultValue="devis"
          options={DOCUMENT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
        />
        <Select
          name="companyId"
          label="Client"
          required
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          name="dealId"
          label="Copy from deal"
          options={[{ value: '', label: '— start empty —' }].concat(
            deals.map((d) => ({ value: d.id, label: d.label })),
          )}
          hint="Brings the deal's services and discount onto the draft."
        />
        <TextInput name="subject" label="Subject" placeholder="Brand film — phase 1" />
      </FormGrid>
      <div className="mt-5">
        <Submit />
      </div>
      <p className="hint mt-3">
        A draft has no number and can be edited freely. It takes its number the
        moment you issue it, and becomes read-only from then on.
      </p>
    </form>
  );
}

'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextArea, TextInput } from '@/components/ui';
import { PROJECT_STATUSES } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function ProjectForm({
  action,
  companies,
  team,
  submitLabel,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  companies: ReadonlyArray<{ id: string; name: string }>;
  team: ReadonlyArray<{ id: string; full_name: string }>;
  submitLabel: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="border border-void/25 p-5">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <Select
          name="companyId"
          label="Organisation"
          required
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
        <TextInput name="name" label="Project" required placeholder="Brand film — phase 1" />
        <Select
          name="status"
          label="Status"
          required
          defaultValue="planned"
          options={PROJECT_STATUSES.map((s) => ({ value: s.value, label: s.label }))}
        />
        <Select
          name="leadId"
          label="Project lead"
          options={[{ value: '', label: '— none —' }].concat(
            team.map((t) => ({ value: t.id, label: t.full_name })),
          )}
        />
        <TextInput name="startDate" label="Start" type="date" />
        <TextInput name="dueDate" label="Due" type="date" />
        <TextArea name="description" label="Scope" rows={3} fullWidth />
      </FormGrid>
      <div className="mt-5">
        <Submit label={submitLabel} />
      </div>
    </form>
  );
}

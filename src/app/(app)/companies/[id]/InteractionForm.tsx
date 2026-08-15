'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextArea, TextInput } from '@/components/ui';
import { INTERACTION_KINDS } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Recording…' : 'Add to timeline'}
    </button>
  );
}

export function InteractionForm({
  action,
  defaultOccurredAt,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  /** Now, in Casablanca time, computed on the server to avoid a hydration gap. */
  defaultOccurredAt: string;
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
    <form ref={formRef} action={formAction} className="mt-4 border border-void p-5">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <Select
          name="kind"
          label="Kind"
          required
          defaultValue="note"
          options={INTERACTION_KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
        <TextInput
          name="occurredAt"
          label="Happened on"
          type="datetime-local"
          required
          defaultValue={defaultOccurredAt}
          hint="Casablanca time."
        />
        <TextInput
          name="title"
          label="Subject"
          required
          fullWidth
          placeholder="Call about the shoot schedule"
        />
        <TextArea name="body" label="Detail" rows={4} fullWidth />
      </FormGrid>
      <div className="mt-5">
        <SubmitButton />
      </div>
    </form>
  );
}

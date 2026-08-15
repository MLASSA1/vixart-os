'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextArea, TextInput } from '@/components/ui';
import { TASK_PRIORITIES } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Assigning…' : 'Assign task'}
    </button>
  );
}

export function TaskForm({
  action,
  team,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  team: ReadonlyArray<{ id: string; full_name: string }>;
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
    <form ref={formRef} action={formAction} className="mt-4 border border-void/25 p-5">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <TextInput name="title" label="Task" required placeholder="Colour grade the interview" />
        <Select
          name="assigneeId"
          label="Assign to"
          options={[{ value: '', label: '— unassigned —' }].concat(
            team.map((t) => ({ value: t.id, label: t.full_name })),
          )}
        />
        <Select
          name="priority"
          label="Priority"
          required
          defaultValue="normal"
          options={TASK_PRIORITIES.map((p) => ({ value: p.value, label: p.label }))}
        />
        <TextInput name="dueDate" label="Due" type="date" />
        <TextArea name="description" label="Detail" rows={2} fullWidth />
      </FormGrid>
      <div className="mt-5">
        <Submit />
      </div>
    </form>
  );
}

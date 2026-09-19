'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextInput } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

const KINDS = [
  { value: 'shoot', label: 'Shoot day' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'off', label: 'Day off' },
  { value: 'block', label: 'Focus time' },
] as const;

/**
 * Adding something to your own week.
 *
 * Deliberately not a task. There is no assignee and no status, and the hint
 * below says so — the moment those two blur, "who is doing this and has anyone
 * approved it" stops having an answer.
 */
export function ScheduleForm({
  action,
  defaultDate,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  defaultDate: string;
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
    <form ref={formRef} action={formAction} className="card mt-4 px-5 py-4">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <TextInput name="title" label="What" required placeholder="Talborjt shoot" />
        <Select name="kind" label="Kind" required defaultValue="block" options={[...KINDS]} />
        <TextInput name="startsOn" label="Date" type="date" required defaultValue={defaultDate} />
        <TextInput name="endsOn" label="Until" type="date" hint="Leave blank for a single day." />
        <TextInput name="note" label="Note" fullWidth placeholder="Call time 07:30, small van" />
      </FormGrid>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Submit />
        <span className="hint">
          Only you can see this. If it needs an owner and a sign-off, it is a task —
          raise it in Tasks instead.
        </span>
      </div>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Adding…' : 'Add to my week'}
    </button>
  );
}

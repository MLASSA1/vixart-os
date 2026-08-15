'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { Checkbox, ErrorBanner, FormGrid, TextInput } from '@/components/ui';
import type { Contact } from '@/db/schema';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function ContactForm({
  action,
  record,
  submitLabel,
  resetOnSuccess,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  record?: Contact;
  submitLabel: string;
  /** Clears the fields after a successful add, ready for the next contact. */
  resetOnSuccess?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (resetOnSuccess && !result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="mt-4">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <TextInput
          name="fullName"
          label="Full name"
          required
          defaultValue={record?.fullName}
        />
        <TextInput
          name="roleTitle"
          label="Role"
          defaultValue={record?.roleTitle}
          placeholder="Managing director"
        />
        <TextInput name="email" label="Email" type="email" defaultValue={record?.email} />
        <TextInput
          name="phone"
          label="Phone"
          type="tel"
          defaultValue={record?.phone}
          placeholder="06 12 34 56 78"
        />
        <TextInput
          name="whatsapp"
          label="WhatsApp"
          type="tel"
          defaultValue={record?.whatsapp}
          placeholder="06 12 34 56 78"
          hint="Moroccan numbers are turned into a wa.me link automatically."
        />
        <TextInput name="notes" label="Note" defaultValue={record?.notes} />
        <Checkbox
          name="isPrimary"
          label="Primary contact"
          checked={record?.isPrimary ?? false}
          hint="One per client. Setting this one clears the previous."
        />
      </FormGrid>
      <div className="mt-5">
        <SubmitButton label={submitLabel} />
      </div>
    </form>
  );
}

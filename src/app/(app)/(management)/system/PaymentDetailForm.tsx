'use client';

import { useKeepOnError } from '@/lib/use-keep-on-error';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, NoticeBanner, TextInput } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Where a client pays.
 *
 * Deliberately NOT reset after a successful save, unlike every other form in
 * the application: this one edits a single standing row rather than adding
 * something to a list, so the values must still be on screen afterwards —
 * both to confirm what was saved and because the next edit is usually a
 * correction to one field.
 */
function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn mt-4" disabled={pending}>
      {pending ? 'Saving…' : 'Save payment details'}
    </button>
  );
}

export function PaymentDetailForm({
  action,
  current,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  current: { bankName: string; rib: string; iban: string; swift: string };
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);
  const keepState = useKeepOnError(state);

  return (
    <form action={formAction} onSubmit={keepState} className="card mt-4 px-5 py-4">
      <ErrorBanner message={state.error} />
      <NoticeBanner message={state.notice} />
      <FormGrid>
        <TextInput
          name="bankName"
          label="Bank"
          defaultValue={current.bankName}
          placeholder="Attijariwafa Bank"
        />
        <TextInput
          name="swift"
          label="SWIFT / BIC"
          defaultValue={current.swift}
          placeholder="BCMAMAMC"
        />
        <TextInput
          name="rib"
          label="RIB"
          defaultValue={current.rib}
          placeholder="24 digits"
        />
        <TextInput
          name="iban"
          label="IBAN"
          defaultValue={current.iban}
          placeholder="MA64…"
        />
      </FormGrid>
      <p className="hint mt-3">
        Spaces are fine — they are stripped before saving. A RIB is 24 digits, a
        Moroccan IBAN is 28 characters beginning MA, and a SWIFT code is 8 or 11.
        Leave a field empty until you have it; the invoice says which are still
        missing rather than inventing one.
      </p>
      <SaveButton />
    </form>
  );
}

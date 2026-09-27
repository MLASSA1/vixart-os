'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, TextInput } from '@/components/ui';
import {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  RECURRING_FREQUENCIES,
} from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : 'Set it running'}
    </button>
  );
}

export function RecurringForm({
  action,
  today,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  today: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<'fixed' | 'variable'>('fixed');
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

      {/* A charge is always money out. Money in arrives from clients paying
          invoices, never from a monthly template — the old toggle here invited
          recording income the agency does not actually receive. */}
      <div className="mb-2 flex gap-2">
        {(['fixed', 'variable'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`btn ${kind === k ? '' : 'btn-inverse'}`}
          >
            {k === 'fixed' ? 'Fixed amount' : 'Amount varies'}
          </button>
        ))}
      </div>
      <p className="hint mb-5">
        {kind === 'fixed'
          ? 'The same figure every month — rent, internet, a subscription. One click to tick it off.'
          : 'Recurs every month but never the same — electricity, water, fuel. The checklist asks for the amount.'}
      </p>
      <input type="hidden" name="kind" value={kind} />

      <FormGrid>
        <TextInput
          name="description"
          label="What is it"
          required
          placeholder="Office rent"
        />
        <TextInput
          name="amount"
          label={kind === 'fixed' ? 'Amount (DH)' : 'Usual amount (DH)'}
          required
          placeholder="6 000"
          hint={
            kind === 'fixed'
              ? undefined
              : 'A starting point only — you correct it each month when you pay.'
          }
        />

        <label className="block" htmlFor="rec-category">
          <span className="label block">Category *</span>
          <select id="rec-category" name="category" required className="input">
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block" htmlFor="rec-frequency">
          <span className="label block">How often *</span>
          <select id="rec-frequency" name="frequency" required className="input" defaultValue="monthly">
            {RECURRING_FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <TextInput
          name="dayOfMonth"
          label="On which day"
          type="number"
          required
          defaultValue="1"
          hint="1 to 28, so February is never a special case."
        />

        <label className="block" htmlFor="rec-method">
          <span className="label block">Paid by *</span>
          <select id="rec-method" name="paymentMethod" required className="input" defaultValue="virement">
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <TextInput
          name="startDate"
          label="Starting from"
          type="date"
          required
          defaultValue={today}
          hint="Backdate it and every month since will be posted at once."
        />
        <TextInput
          name="endDate"
          label="Until (optional)"
          type="date"
          hint="Leave empty to run indefinitely."
        />
        <TextInput name="vat" label="of which VAT (DH)" placeholder="0" />
      </FormGrid>

      <div className="mt-5">
        <Submit />
      </div>
      <p className="hint mt-3">
        Posted automatically each night, and again whenever the stack restarts. A
        period can only ever be posted once, so nothing is double-counted.
      </p>
    </form>
  );
}

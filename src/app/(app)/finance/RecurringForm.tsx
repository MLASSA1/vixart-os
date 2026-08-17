'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, TextInput } from '@/components/ui';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
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
  const [direction, setDirection] = useState<'income' | 'expense'>('expense');
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  const categories = direction === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  return (
    <form ref={formRef} action={formAction} className="border border-void/25 p-5">
      <ErrorBanner message={state.error} />

      <div className="mb-5 flex gap-2">
        {(['expense', 'income'] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDirection(d)}
            className={`btn ${direction === d ? '' : 'btn-inverse'}`}
          >
            {d === 'expense' ? 'Money out' : 'Money in'}
          </button>
        ))}
      </div>
      <input type="hidden" name="direction" value={direction} />

      <FormGrid>
        <TextInput
          name="description"
          label="What is it"
          required
          placeholder="Office rent"
        />
        <TextInput name="amount" label="Amount (DH)" required placeholder="6 000" />

        <label className="block" htmlFor="rec-category">
          <span className="label block">Category *</span>
          <select id="rec-category" name="category" required className="input" key={direction}>
            {categories.map((c) => (
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

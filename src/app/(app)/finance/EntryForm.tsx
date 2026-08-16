'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, TextInput } from '@/components/ui';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, PAYMENT_METHODS } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Recording…' : 'Record movement'}
    </button>
  );
}

export function EntryForm({
  action,
  companies,
  today,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  companies: ReadonlyArray<{ id: string; name: string }>;
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

      {/* Direction first: it changes which categories make sense. */}
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
          name="amount"
          label="Amount (DH)"
          required
          placeholder="1 500"
          hint="Always positive — the direction above says whether it is in or out."
        />
        <TextInput name="entryDate" label="Date" type="date" required defaultValue={today} />

        <label className="block" htmlFor="category">
          <span className="label block">Category *</span>
          <select id="category" name="category" required className="input" key={direction}>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block" htmlFor="paymentMethod">
          <span className="label block">Paid by *</span>
          <select id="paymentMethod" name="paymentMethod" required className="input" defaultValue="virement">
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <TextInput
          name="vat"
          label="of which VAT (DH)"
          placeholder="0"
          hint="Optional. Helps the accountant reclaim it."
        />
        <TextInput
          name="reference"
          label="Receipt reference"
          placeholder="Bill number"
          hint="So the paper can be matched to the line."
        />

        <label className="block sm:col-span-2" htmlFor="companyId">
          <span className="label block">Client (optional)</span>
          <select id="companyId" name="companyId" className="input" defaultValue="">
            <option value="">— not client related —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <TextInput
          name="description"
          label="Description"
          placeholder="August electricity bill"
          fullWidth
        />
      </FormGrid>

      <div className="mt-5">
        <Submit />
      </div>
      <p className="hint mt-3">
        Invoice revenue is not entered here. It posts itself when you mark an
        invoice paid, so the ledger can never disagree with the invoices.
      </p>
    </form>
  );
}

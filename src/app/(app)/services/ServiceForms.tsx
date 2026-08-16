'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextArea, TextInput } from '@/components/ui';
import { PILLARS, SERVICE_UNITS } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

export function ServiceForm({
  action,
  record,
  submitLabel,
  withPrice,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  record?: { name: string; pillar: string; unit: string; description: string | null };
  submitLabel: string;
  /** Only shown when creating: an existing service changes price separately. */
  withPrice?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error && withPrice) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="border border-void/25 p-5">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <TextInput name="name" label="Service" required defaultValue={record?.name} />
        <Select
          name="pillar"
          label="Pillar"
          required
          defaultValue={record?.pillar ?? 'brand_architecture'}
          options={PILLARS.map((p) => ({ value: p.value, label: p.label }))}
        />
        <Select
          name="unit"
          label="Billed as"
          required
          defaultValue={record?.unit ?? 'forfait'}
          options={SERVICE_UNITS.map((u) => ({ value: u.value, label: u.label }))}
        />
        {withPrice && (
          <TextInput
            name="price"
            label="Starting price (DH)"
            placeholder="0"
            hint="Excluding VAT. Leave at 0 until you have decided."
          />
        )}
        <TextArea
          name="description"
          label="What it covers"
          rows={2}
          defaultValue={record?.description}
          fullWidth
        />
      </FormGrid>
      <div className="mt-5">
        <Submit label={submitLabel} busy="Saving…" />
      </div>
    </form>
  );
}

export function PriceForm({
  action,
  today,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  today: string;
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
    <form ref={formRef} action={formAction} className="mt-3">
      <ErrorBanner message={state.error} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block" htmlFor="price">
          <span className="label block">New price (DH)</span>
          <input id="price" name="price" required className="input w-36" placeholder="12 000" />
        </label>
        <label className="block" htmlFor="effectiveFrom">
          <span className="label block">Applies from</span>
          <input
            id="effectiveFrom"
            name="effectiveFrom"
            type="date"
            required
            defaultValue={today}
            className="input w-44"
          />
        </label>
        <label className="block flex-1" htmlFor="note">
          <span className="label block">Why (optional)</span>
          <input id="note" name="note" className="input" placeholder="2027 rate card" />
        </label>
        <Submit label="Add price version" busy="Adding…" />
      </div>
      <p className="hint mt-2">
        This adds a version. The current price stays on record, and any document
        already issued under it is untouched.
      </p>
    </form>
  );
}

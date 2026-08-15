'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextArea, TextInput } from '@/components/ui';
import { DEAL_STAGES } from '@/lib/labels';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function DealForm({
  action,
  companies,
  record,
  submitLabel,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  companies: ReadonlyArray<{ id: string; name: string }>;
  record?: {
    id: string;
    companyId: string;
    title: string;
    description: string | null;
    stage: string;
    probability: number;
    expectedCloseDate: string | null;
    lostReason: string | null;
    value: string;
  };
  submitLabel: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [stage, setStage] = useState(record?.stage ?? 'proposal');

  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error && !record) formRef.current?.reset();
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
          defaultValue={record?.companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
        <TextInput
          name="title"
          label="Opportunity"
          required
          defaultValue={record?.title}
          placeholder="Brand film + launch campaign"
        />
        <TextInput
          name="value"
          label="Estimated value (DH)"
          defaultValue={record?.value}
          placeholder="120 000"
          hint="Excluding VAT. Typed as text and stored in centimes — never a rounded float."
        />
        <TextInput
          name="probability"
          label="Confidence (%)"
          type="number"
          defaultValue={String(record?.probability ?? 50)}
          hint="Used for the weighted forecast."
        />
        {/* Controlled directly: choosing "Lost" reveals the reason field, which
            the database also requires via the deal_lost_needs_reason CHECK. */}
        <label className="block" htmlFor="stage">
          <span className="label block">Stage *</span>
          <select
            id="stage"
            name="stage"
            required
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            className="input"
          >
            {DEAL_STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <TextInput
          name="expectedCloseDate"
          label="Expected close"
          type="date"
          defaultValue={record?.expectedCloseDate}
        />
        <TextArea
          name="description"
          label="Scope"
          rows={3}
          defaultValue={record?.description}
          fullWidth
        />
        {stage === 'lost' && (
          <TextArea
            name="lostReason"
            label="Why was it lost?"
            rows={2}
            required
            defaultValue={record?.lostReason}
            fullWidth
            hint="Required. A lost deal without a reason teaches nothing."
          />
        )}
      </FormGrid>

      <div className="mt-5">
        <Submit label={submitLabel} />
      </div>
    </form>
  );
}

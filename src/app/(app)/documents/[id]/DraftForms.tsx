'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, TextArea, TextInput } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

export function AddLineForm({
  action,
  services,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  services: ReadonlyArray<{ id: string; name: string; unit_label: string; price: string }>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [free, setFree] = useState(false);
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

      <label className="mb-4 flex items-center gap-2">
        <input
          type="checkbox"
          checked={free}
          onChange={(e) => setFree(e.target.checked)}
          className="h-4 w-4 accent-[#0B0B0F]"
        />
        <span className="label">Free line — something not in the catalog</span>
      </label>

      <div className="flex flex-wrap items-end gap-3">
        {free ? (
          <>
            <label className="block min-w-64 flex-1" htmlFor="label">
              <span className="label block">Description</span>
              <input id="label" name="label" required className="input" />
            </label>
            <label className="block" htmlFor="price">
              <span className="label block">Unit price (DH)</span>
              <input id="price" name="price" className="input w-36" placeholder="0" />
            </label>
          </>
        ) : (
          <label className="block min-w-64 flex-1" htmlFor="serviceId">
            <span className="label block">Service</span>
            <select id="serviceId" name="serviceId" required className="input" defaultValue="">
              <option value="" disabled>
                Pick a service…
              </option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.price} / {s.unit_label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block" htmlFor="quantity">
          <span className="label block">Quantity</span>
          <input id="quantity" name="quantity" defaultValue="1" className="input w-24" />
        </label>
        <Submit label="Add line" busy="Adding…" />
      </div>
    </form>
  );
}

export function DraftSettingsForm({
  action,
  values,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  values: {
    discount: string;
    vatRateBp: number;
    vatExemptionReason: string;
    subject: string;
    notes: string;
    paymentTerms: string;
    dueDate: string;
  };
}) {
  const [vat, setVat] = useState(values.vatRateBp);
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  return (
    <form action={formAction} className="mt-4 border border-void/25 p-5">
      <ErrorBanner message={state.error} />
      <FormGrid>
        <TextInput name="subject" label="Subject" defaultValue={values.subject} />
        <TextInput
          name="discount"
          label="Discount (DH)"
          defaultValue={values.discount}
          placeholder="0"
          hint="A fixed amount, taken off before VAT."
        />

        <label className="block" htmlFor="vatRateBp">
          <span className="label block">VAT rate</span>
          <select
            id="vatRateBp"
            name="vatRateBp"
            className="input"
            value={vat}
            onChange={(e) => setVat(Number(e.target.value))}
          >
            <option value={2000}>20 % — standard</option>
            <option value={1400}>14 %</option>
            <option value={1000}>10 %</option>
            <option value={700}>7 %</option>
            <option value={0}>0 % — exempt</option>
          </select>
        </label>

        <TextInput name="dueDate" label="Due date" type="date" defaultValue={values.dueDate} />

        {vat === 0 && (
          <TextArea
            name="vatExemptionReason"
            label="Reason for the exemption"
            rows={2}
            required
            defaultValue={values.vatExemptionReason}
            fullWidth
            hint="Required. This is a legal claim printed on the document, and the database refuses a 0 % rate without it."
          />
        )}

        <TextInput
          name="paymentTerms"
          label="Payment terms"
          defaultValue={values.paymentTerms}
          placeholder="Payable within 30 days"
          fullWidth
        />
        <TextArea name="notes" label="Notes" rows={2} defaultValue={values.notes} fullWidth />
      </FormGrid>
      <div className="mt-5">
        <Submit label="Save draft" busy="Saving…" />
      </div>
    </form>
  );
}

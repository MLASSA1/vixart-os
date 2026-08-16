'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
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
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="mt-4">
      <ErrorBanner message={state.error} />
      <div className="flex flex-wrap items-end gap-3">
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
        <label className="block" htmlFor="quantity">
          <span className="label block">Quantity</span>
          <input
            id="quantity"
            name="quantity"
            defaultValue="1"
            className="input w-28"
            placeholder="1"
          />
        </label>
        <Submit label="Add to deal" busy="Adding…" />
      </div>
      <p className="hint mt-2">
        The price is copied onto the line now. Changing the catalog later will not
        move this deal.
      </p>
    </form>
  );
}

export function DiscountForm({
  action,
  current,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  current: string;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  return (
    <form action={formAction} className="mt-3">
      <ErrorBanner message={state.error} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block" htmlFor="discount">
          <span className="label block">Discount (DH)</span>
          <input
            id="discount"
            name="discount"
            defaultValue={current}
            className="input w-40"
            placeholder="0"
          />
        </label>
        <Submit label="Apply discount" busy="Saving…" />
      </div>
      <p className="hint mt-2">
        A fixed amount off the total, taken before VAT.
      </p>
    </form>
  );
}

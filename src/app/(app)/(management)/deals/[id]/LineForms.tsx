'use client';

import { useActionState, useState, useRef } from 'react';
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

/**
 * The advance the client pays to start.
 *
 * The percentage buttons are a calculator, not a stored setting: they fill the
 * amount from the deal's own total and then get out of the way. What is saved
 * is dirhams — because that is what the client transfers, what the invoice
 * states, and what the books record.
 */
export function AdvanceForm({
  action,
  current,
  totalCentimes,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  current: string;
  /** Total incl. VAT of this deal, centimes as a string. */
  totalCentimes: string;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);
  const [value, setValue] = useState(current);

  const total = BigInt(totalCentimes);

  function share(percent: number) {
    // Half-up on centimes, the same rounding the rest of the money code uses.
    const cents = (total * BigInt(percent) + 50n) / 100n;
    setValue((cents / 100n).toString() + (cents % 100n ? ',' + (cents % 100n).toString().padStart(2, '0') : ''));
  }

  return (
    <form action={formAction} className="mt-6 border-t border-void/10 pt-5">
      <ErrorBanner message={state.error} />
      <p className="label">Advance to start</p>
      <p className="hint mt-0.5 mb-3">
        What the client pays before work begins. The balance falls due on delivery.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block" htmlFor="advance">
          <span className="label block">Amount (DH)</span>
          <input
            id="advance"
            name="advance"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="input w-40"
            placeholder="0"
            inputMode="decimal"
          />
        </label>

        {total > 0n && (
          <div className="flex gap-1.5 pb-1">
            {[20, 30, 50].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => share(p)}
                className="btn btn-inverse btn-small"
              >
                {p} %
              </button>
            ))}
          </div>
        )}

        <Submit label="Save advance" busy="Saving…" />
      </div>

      <p className="hint mt-2">
        Saved in dirhams. If the deal total changes later, this figure stays as
        agreed until you change it.
      </p>
    </form>
  );
}

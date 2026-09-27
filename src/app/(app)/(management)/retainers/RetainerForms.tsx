'use client';

import { useActionState, useRef, useState } from 'react';
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

/** Sign a client onto a monthly contract. */
export function NewRetainerForm({
  action,
  clients,
  today,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  clients: ReadonlyArray<{ id: string; name: string }>;
  today: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [term, setTerm] = useState('3');
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="rounded-xl border border-void/15 p-5">
      <ErrorBanner message={state.error} />

      <div className="grid gap-4 sm:grid-cols-12">
        <label className="block sm:col-span-4">
          <span className="label block">Client</span>
          <select name="companyId" required className="input" defaultValue="">
            <option value="">Choose…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        <label className="block sm:col-span-5">
          <span className="label block">What they are paying for</span>
          <input name="label" required className="input" placeholder="Social media management" />
        </label>

        <label className="block sm:col-span-3">
          <span className="label block">Per month (DH)</span>
          <input name="monthly" inputMode="decimal" required className="input" placeholder="6 000" />
        </label>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-12">
        <label className="block sm:col-span-3">
          <span className="label block">Starts</span>
          <input type="date" name="startDate" required defaultValue={today} className="input" />
        </label>

        <label className="block sm:col-span-3">
          <span className="label block">Committed term</span>
          <select
            name="termMonths"
            className="input"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          >
            <option value="3">3 months</option>
            <option value="6">6 months</option>
            <option value="12">12 months</option>
            <option value="1">1 month — no commitment</option>
          </select>
        </label>

        <label className="block sm:col-span-3">
          <span className="label block">Billed on the</span>
          <select name="billingDay" className="input" defaultValue="1">
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>

        <label className="flex items-start gap-2 sm:col-span-3 sm:pt-6">
          <input
            type="checkbox"
            name="autoRenew"
            value="yes"
            defaultChecked
            className="mt-1 h-4 w-4 accent-[#6D28D9]"
          />
          <span>
            <span className="label block">Renews itself</span>
            <span className="hint">Rolls into another term unless ended.</span>
          </span>
        </label>
      </div>

      {term === '1' && (
        <p className="tone-warn mt-4 rounded-[10px] px-4 py-3 text-[14px]">
          No commitment means the client can take the first month — the audit, the
          brand work, the setup — and leave before any of it compounds. Three months
          is the shortest term that makes that first month worth doing.
        </p>
      )}

      <label className="mt-4 block">
        <span className="label block">Notes</span>
        <textarea name="notes" rows={2} className="input" placeholder="What is in scope, what is not" />
      </label>

      <div className="mt-4">
        <Submit label="Start the retainer" busy="Saving…" />
      </div>
    </form>
  );
}

/** Ending one. The reason is the point, so the form is about the reason. */
export function EndRetainerForm({
  action,
  retainerId,
  label,
  inCommittedTerm,
  termEnds,
  today,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  retainerId: string;
  label: string;
  inCommittedTerm: boolean;
  termEnds: string;
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  if (!open) {
    return (
      <button
        type="button"
        className="hint cursor-pointer underline underline-offset-4"
        onClick={() => setOpen(true)}
      >
        End
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-3 w-full rounded-xl border border-void/20 p-4">
      <ErrorBanner message={state.error} />
      <input type="hidden" name="retainerId" value={retainerId} />

      <p className="label">Ending “{label}”</p>

      {inCommittedTerm && (
        <p className="tone-warn mt-2 rounded-[10px] px-3 py-2 text-[13px]">
          This is inside the committed term, which runs to {termEnds}. You can end it
          anyway — a client who wants to go will go — but record what happened.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-64 flex-1">
          <span className="label block">Why did it end</span>
          <input
            name="endReason"
            required
            className="input"
            placeholder="Budget cut, went in-house, unhappy with…, project finished"
          />
        </label>
        <label className="block">
          <span className="label block">Ended on</span>
          <input type="date" name="endedOn" defaultValue={today} className="input w-40" />
        </label>
        <Submit label="End it" busy="Ending…" />
        <button
          type="button"
          className="hint cursor-pointer underline underline-offset-4"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

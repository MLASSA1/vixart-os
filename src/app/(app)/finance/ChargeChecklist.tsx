'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * This month's charges, and whether each one has actually been paid.
 *
 * The rule the whole screen rests on: a charge falling due is not the same as
 * a charge being paid. Nothing here writes to the books until someone says the
 * money went — and when they do, the amount is theirs to correct, because rent
 * with a repair added is still rent and an electricity bill is never twice the
 * same.
 */

export interface ChargeRow {
  id: string;
  description: string;
  category: string;
  categoryLabel: string;
  kind: 'fixed' | 'variable';
  /** Expected amount, centimes as a string. */
  expected: string;
  dayOfMonth: number;
  /** Set when this month is already paid. */
  paid: null | { amount: string; paidOn: string; method: string };
}

const METHOD_LABELS: Record<string, string> = {
  virement: 'Bank transfer',
  especes: 'Cash',
  cheque: 'Cheque',
  carte: 'Card',
  autre: 'Other',
};

function formatMAD(centimes: bigint): string {
  const n = centimes < 0n ? -centimes : centimes;
  const whole = (n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${centimes < 0n ? '−' : ''}${whole},${(n % 100n).toString().padStart(2, '0')} DH`;
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-small" disabled={pending}>
      {pending ? '…' : label}
    </button>
  );
}

function PayRow({
  charge,
  period,
  today,
  pay,
}: {
  charge: ChargeRow;
  period: string;
  today: string;
  pay: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(pay, EMPTY_STATE);
  const [open, setOpen] = useState(false);

  // A fixed charge is one click. A variable one has nothing sensible to
  // assume, so it opens straight into the amount.
  const needsAmount = charge.kind === 'variable';

  return (
    <div>
      <ErrorBanner message={state.error} />
      {!open && !needsAmount ? (
        <form action={formAction} className="flex items-center gap-2">
          <input type="hidden" name="chargeId" value={charge.id} />
          <input type="hidden" name="period" value={period} />
          <input type="hidden" name="amount" value={(BigInt(charge.expected) / 100n).toString()} />
          <input type="hidden" name="paidOn" value={today} />
          <Submit label="Mark paid" />
          <button
            type="button"
            className="hint cursor-pointer underline underline-offset-4"
            onClick={() => setOpen(true)}
          >
            different amount
          </button>
        </form>
      ) : (
        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="chargeId" value={charge.id} />
          <input type="hidden" name="period" value={period} />
          <label className="block">
            <span className="label block">Amount paid (DH)</span>
            <input
              name="amount"
              inputMode="decimal"
              required
              className="input mt-0.5 w-32"
              defaultValue={
                needsAmount ? '' : (BigInt(charge.expected) / 100n).toString()
              }
              placeholder={
                needsAmount ? (BigInt(charge.expected) / 100n).toString() : '0'
              }
            />
          </label>
          <label className="block">
            <span className="label block">On</span>
            <input type="date" name="paidOn" defaultValue={today} className="input mt-0.5 w-36" />
          </label>
          <label className="block">
            <span className="label block">How</span>
            <select name="method" className="input mt-0.5 w-32" defaultValue="virement">
              <option value="virement">Transfer</option>
              <option value="especes">Cash</option>
              <option value="cheque">Cheque</option>
              <option value="carte">Card</option>
              <option value="autre">Other</option>
            </select>
          </label>
          <Submit label="Record" />
        </form>
      )}
    </div>
  );
}

export function ChargeChecklist({
  charges,
  period,
  periodLabel,
  today,
  pay,
  unpay,
}: {
  charges: ChargeRow[];
  /** 'YYYY-MM' */
  period: string;
  periodLabel: string;
  today: string;
  pay: (state: FormState, formData: FormData) => Promise<FormState>;
  unpay: (formData: FormData) => Promise<void>;
}) {
  const paid = charges.filter((c) => c.paid);
  const due = charges.filter((c) => !c.paid);

  const paidTotal = paid.reduce((a, c) => a + BigInt(c.paid!.amount), 0n);
  const dueTotal = due.reduce((a, c) => a + BigInt(c.expected), 0n);

  if (charges.length === 0) {
    return (
      <p className="hint">
        No charges set up yet. Add rent, internet, salaries and the like below —
        they will appear here every month, waiting to be ticked off.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p>
          <span className="code text-lg font-bold">{paid.length}</span>
          <span className="hint"> of {charges.length} paid for {periodLabel}</span>
        </p>
        <p className={`chip ${due.length === 0 ? 'tone-ok' : 'tone-warn'}`}>
          {due.length === 0
            ? `All paid — ${formatMAD(paidTotal)}`
            : `${formatMAD(dueTotal)} still to pay`}
        </p>
      </div>

      <ul className="mt-4 divide-y divide-void/10">
        {[...due, ...paid].map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
            <div className="min-w-0">
              <p className="font-semibold">
                {c.description}
                {c.kind === 'variable' && (
                  <span className="chip tone-quiet ml-2">amount varies</span>
                )}
              </p>
              <p className="hint">
                {c.categoryLabel} · due on the {c.dayOfMonth}
                {c.paid
                  ? ` · paid ${c.paid.paidOn} by ${METHOD_LABELS[c.paid.method] ?? c.paid.method}`
                  : ` · ${c.kind === 'variable' ? 'usually ' : ''}${formatMAD(BigInt(c.expected))}`}
              </p>
            </div>

            {c.paid ? (
              <div className="flex items-center gap-3">
                <span className="chip tone-ok">{formatMAD(BigInt(c.paid.amount))} paid</span>
                <form action={unpay}>
                  <input type="hidden" name="chargeId" value={c.id} />
                  <input type="hidden" name="period" value={period} />
                  <button
                    type="submit"
                    className="hint cursor-pointer underline underline-offset-4"
                  >
                    Undo
                  </button>
                </form>
              </div>
            ) : (
              <PayRow charge={c} period={period} today={today} pay={pay} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

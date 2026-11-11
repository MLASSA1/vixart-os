'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, NoticeBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { useKeepOnError } from '@/lib/use-keep-on-error';

/**
 * Every payment on record, and every reversal of one.
 *
 * Nothing in this list is ever removed (0083). A mistaken or bounced payment
 * stays where it is, marked reversed, and its reversal appears beside it as a
 * negative line with the reason — so anybody reading it later sees what
 * happened rather than a gap. The same list serves an invoice and a client's
 * whole history.
 *
 * "Reverse" is offered only to the owner, and the database refuses it from
 * anybody else whatever this component renders.
 */

export interface PaymentListRow {
  id: string;
  /** Centimes as a string; negative on a reversal. */
  amount: string;
  method: string;
  paidOn: string;
  note: string | null;
  recordedBy: string | null;
  /** Set on a reversal: the payment it cancels. */
  reversesId: string | null;
  /** Set on a payment that has been reversed: when. */
  reversedOn: string | null;
  /** For a client's history: which invoice. */
  invoice?: { id: string; number: string | null };
}

const METHOD: Record<string, string> = {
  virement: 'Bank transfer',
  especes: 'Cash',
  cheque: 'Cheque',
  carte: 'Card',
  autre: 'Other',
};

function money(centimes: bigint): string {
  const negative = centimes < 0n;
  const n = negative ? -centimes : centimes;
  const whole = (n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${whole},${(n % 100n).toString().padStart(2, '0')} DH`;
}

function ReverseButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-inverse btn-small" disabled={pending}>
      {pending ? 'Reversing…' : 'Reverse this payment'}
    </button>
  );
}

function ReverseForm({
  paymentId,
  amount,
  action,
}: {
  paymentId: string;
  amount: string;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);
  const keepState = useKeepOnError(state);
  return (
    <details className="mt-2">
      <summary className="hint cursor-pointer underline underline-offset-4">Reverse</summary>
      <form action={formAction} onSubmit={keepState} className="mt-2 rounded-[10px] border border-void/10 p-3">
        <ErrorBanner message={state.error} />
        <NoticeBanner message={state.notice} />
        <input type="hidden" name="paymentId" value={paymentId} />
        <p className="hint mb-2">
          Adds a reversal of {money(-BigInt(amount))}. The payment stays on record, marked reversed;
          the balance goes back up by {money(BigInt(amount))}.
        </p>
        <label className="block">
          <span className="label block">Why</span>
          <input name="reason" required className="input" placeholder="Cheque bounced, recorded twice…" />
        </label>
        <div className="mt-2">
          <ReverseButton />
        </div>
      </form>
    </details>
  );
}

export function PaymentList({
  rows,
  canReverse,
  reverseAction,
}: {
  rows: PaymentListRow[];
  canReverse: boolean;
  reverseAction?: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="divide-y divide-void/10">
      {rows.map((p) => {
        const amount = BigInt(p.amount);
        const isReversal = p.reversesId !== null;
        const reversed = p.reversedOn !== null;
        return (
          <li key={p.id} className="py-2.5" data-row>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <div className="min-w-0">
                <span className={`code font-semibold ${reversed ? 'line-through decoration-void/50' : ''}`}>
                  {money(amount)}
                </span>
                {isReversal && <span className="chip tone-warn ml-2">Reversal</span>}
                {reversed && <span className="chip tone-quiet ml-2">Reversed {p.reversedOn}</span>}
                <span className="hint">
                  {' '}· {METHOD[p.method] ?? p.method} · {p.paidOn}
                  {p.recordedBy && <> · recorded by {p.recordedBy}</>}
                </span>
                {p.invoice && (
                  <span className="hint">
                    {' '}· <Link href={`/documents/${p.invoice.id}`} className="underline underline-offset-4">{p.invoice.number ?? 'invoice'}</Link>
                  </span>
                )}
                {p.note && <p className="hint mt-0.5">{isReversal ? `Why: ${p.note}` : p.note}</p>}
              </div>
            </div>
            {canReverse && reverseAction && !isReversal && !reversed && amount > 0n && (
              <ReverseForm paymentId={p.id} amount={p.amount} action={reverseAction} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

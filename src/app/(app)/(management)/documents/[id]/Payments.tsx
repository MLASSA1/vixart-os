'use client';

import { useKeepOnError } from '@/lib/use-keep-on-error';
import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { PaymentList, type PaymentListRow } from '@/components/PaymentList';

/**
 * Money received against this invoice.
 *
 * The advance is whatever was agreed — an amount in dirhams, not a fixed
 * share. The bar shows how much of the net is in; the invoice settles itself
 * when the payments cover it, and from that moment the payments are locked.
 */

/** Every payment and reversal on this invoice — none is ever removed (0083). */
export type PaymentRow = PaymentListRow;

function formatMAD(centimes: bigint): string {
  const negative = centimes < 0n;
  const n = negative ? -centimes : centimes;
  const whole = (n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${whole},${(n % 100n).toString().padStart(2, '0')} DH`;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Recording…' : 'Record payment'}
    </button>
  );
}

export function Payments({
  documentId,
  advanceExpected,
  net,
  payments,
  settled,
  today,
  record,
  reverse,
  canReverse,
}: {
  documentId: string;
  /** Advance agreed on the deal, centimes as a string. '0' if none. */
  advanceExpected: string;
  /** net_to_collect, centimes as a string. */
  net: string;
  payments: PaymentRow[];
  /** true once the invoice is paye — payments become read-only. */
  settled: boolean;
  today: string;
  record: (state: FormState, formData: FormData) => Promise<FormState>;
  reverse: (state: FormState, formData: FormData) => Promise<FormState>;
  /** The owner only. The database refuses anybody else regardless. */
  canReverse: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await record(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );
  const keepState = useKeepOnError(state);

  const netC = BigInt(net);
  const paid = payments.reduce((acc, p) => acc + BigInt(p.amount), 0n);
  const rest = netC - paid;
  const pct = netC > 0n ? Number((paid * 100n) / netC) : 0;

  return (
    <div>
      {/* How much of the net is in. Width is the figure; colour says done. */}
      <div className="flex items-baseline justify-between">
        <p>
          <span className="code text-lg font-bold">{formatMAD(paid)}</span>
          <span className="hint"> received of {formatMAD(netC)}</span>
        </p>
        <p className={`chip ${settled ? 'tone-ok' : rest > 0n && paid > 0n ? 'tone-warn' : 'tone-quiet'}`}>
          {settled ? 'Settled in full' : paid > 0n ? `${formatMAD(rest)} remaining` : 'Nothing received yet'}
        </p>
      </div>
      {/* The advance agreed on the deal, shown against what has arrived. It is
          a term, not a movement: it never posts anything by itself. */}
      {BigInt(advanceExpected) > 0n && (
        <p className="hint mt-2">
          {paid >= BigInt(advanceExpected)
            ? `Advance of ${formatMAD(BigInt(advanceExpected))} agreed on the deal — received.`
            : `Advance of ${formatMAD(BigInt(advanceExpected))} agreed on the deal to start work` +
              (paid > 0n ? ` — ${formatMAD(BigInt(advanceExpected) - paid)} of it still to come.` : '.')}
        </p>
      )}

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-void/10">
        <div
          className={`h-full rounded-full ${settled ? 'bg-ok' : 'bg-accent'}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>

      {payments.length > 0 && (
        <div className="mt-5">
          <PaymentList rows={payments} canReverse={canReverse} reverseAction={reverse} />
        </div>
      )}

      {settled ? (
        <p className="hint mt-4">
          Settled in full. Payments are never removed: if one bounced or was recorded by
          mistake, {canReverse ? 'reverse it above' : 'the owner can reverse it'} and the invoice
          reopens for the balance. A change to the invoice itself is a credit note.
        </p>
      ) : (
        <form ref={formRef} action={formAction} onSubmit={keepState} className="mt-5 border-t border-void/10 pt-5">
          <ErrorBanner message={state.error} />
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="label block">Amount (DH)</span>
              <input
                name="amount"
                inputMode="decimal"
                required
                className="input w-36"
                placeholder="0,00"
              />
            </label>
            <label className="block">
              <span className="label block">Method</span>
              <select name="method" className="input w-40" defaultValue="virement">
                <option value="virement">Bank transfer</option>
                <option value="especes">Cash</option>
                <option value="cheque">Cheque</option>
                <option value="carte">Card</option>
                <option value="autre">Other</option>
              </select>
            </label>
            <label className="block">
              <span className="label block">Received on</span>
              <input type="date" name="paidOn" defaultValue={today} className="input w-40" />
            </label>
            <label className="block min-w-44 flex-1">
              <span className="label block">Note</span>
              <input name="note" className="input" placeholder="Advance on signature" />
            </label>
            <Submit />
          </div>
          <p className="hint mt-3">
            The advance is whatever was agreed — 10%, 30%, any amount in dirhams. Each
            payment lands in the books with its method and date, and the invoice marks
            itself paid when the money covers it.
          </p>
        </form>
      )}
    </div>
  );
}

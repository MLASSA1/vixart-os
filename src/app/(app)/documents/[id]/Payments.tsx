'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Money received against this invoice.
 *
 * The advance is whatever was agreed — an amount in dirhams, not a fixed
 * share. The bar shows how much of the net is in; the invoice settles itself
 * when the payments cover it, and from that moment the payments are locked.
 */

export interface PaymentRow {
  id: string;
  amount: string;      // centimes, stringified
  method: string;
  paidOn: string;
  note: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  virement: 'Bank transfer',
  especes: 'Cash',
  cheque: 'Cheque',
  carte: 'Card',
  autre: 'Other',
};

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
  net,
  payments,
  settled,
  today,
  record,
  remove,
}: {
  /** net_to_collect, centimes as a string. */
  net: string;
  payments: PaymentRow[];
  /** true once the invoice is paye — payments become read-only. */
  settled: boolean;
  today: string;
  record: (state: FormState, formData: FormData) => Promise<FormState>;
  remove: (formData: FormData) => Promise<void>;
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
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-void/10">
        <div
          className={`h-full rounded-full ${settled ? 'bg-ok' : 'bg-accent'}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>

      {payments.length > 0 && (
        <ul className="mt-5 divide-y divide-void/10">
          {payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
              <div>
                <span className="code font-semibold">{formatMAD(BigInt(p.amount))}</span>
                <span className="hint"> · {METHOD_LABELS[p.method] ?? p.method} · {p.paidOn}</span>
                {p.note && <span className="hint"> — {p.note}</span>}
              </div>
              {!settled && (
                <form action={remove}>
                  <input type="hidden" name="paymentId" value={p.id} />
                  <button type="submit" className="hint cursor-pointer underline underline-offset-4">
                    Remove
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {settled ? (
        <p className="hint mt-4">
          Payments on a settled invoice are locked. If something is wrong here, the
          correction is a credit note — same as any other change to an issued invoice.
        </p>
      ) : (
        <form ref={formRef} action={formAction} className="mt-5 border-t border-void/10 pt-5">
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

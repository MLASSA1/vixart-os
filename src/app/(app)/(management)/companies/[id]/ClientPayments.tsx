'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, Section } from '@/components/ui';
import { PaymentList, type PaymentListRow } from '@/components/PaymentList';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { useKeepOnError } from '@/lib/use-keep-on-error';

/**
 * Taking a payment from the client's own page, and every payment they have
 * ever made.
 *
 * Amin: when a client pays some of what they owe, we enter it, it saves how
 * much they paid this time, the total owed goes down — and the record of the
 * payment always stays, on the client's page. Recording used to be possible
 * only from inside each invoice; here the invoice is chosen, the amount
 * starts at what is left on it, and the history underneath shows every
 * payment and every reversal, across all their invoices, for good.
 */

export interface OpenInvoice {
  id: string;
  number: string;
  /** What is left to collect, centimes as a string. */
  remaining: string;
}

function dirhams(centimes: string): string {
  const c = BigInt(centimes);
  return `${(c / 100n).toString()},${(c % 100n).toString().padStart(2, '0')}`;
}

function money(centimes: string): string {
  const c = BigInt(centimes);
  const whole = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole},${(c % 100n).toString().padStart(2, '0')} DH`;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Recording…' : 'Record payment'}
    </button>
  );
}

export function ClientPayments({
  openInvoices,
  history,
  today,
  canReverse,
  record,
  reverse,
}: {
  openInvoices: OpenInvoice[];
  history: PaymentListRow[];
  today: string;
  canReverse: boolean;
  record: (state: FormState, formData: FormData) => Promise<FormState>;
  reverse: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(record, EMPTY_STATE);
  const keepState = useKeepOnError(state);
  // The amount starts at what is left on the chosen invoice: the common case
  // is "they paid the rest", and a smaller deposit is one edit away.
  const [chosen, setChosen] = useState(openInvoices[0]?.id ?? '');
  const invoice = openInvoices.find((i) => i.id === chosen);

  return (
    <>
      <Section title="Record a payment">
        {openInvoices.length === 0 ? (
          <p className="hint">Nothing open: every issued invoice for this client is paid.</p>
        ) : (
          <form action={formAction} onSubmit={keepState}>
            <ErrorBanner message={state.error} />
            <div className="flex flex-wrap items-end gap-3">
              <label className="block min-w-52 flex-1">
                <span className="label block">Invoice</span>
                <select
                  name="documentId"
                  className="input"
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value)}
                >
                  {openInvoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.number} — {money(i.remaining)} left
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label block">Amount (DH)</span>
                <input
                  key={chosen}
                  name="amount"
                  inputMode="decimal"
                  required
                  className="input w-36"
                  defaultValue={invoice ? dirhams(invoice.remaining) : ''}
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
                <input name="note" className="input" placeholder="Second instalment" />
              </label>
              <Submit />
            </div>
          </form>
        )}
      </Section>

      <Section title={`Payment history — ${history.length}`}>
        {history.length === 0 ? (
          <p className="hint">No payment recorded yet.</p>
        ) : (
          <>
            <PaymentList rows={history} canReverse={canReverse} reverseAction={reverse} />
            <p className="hint mt-3">
              Nothing here is ever removed. A reversed payment stays on record next to its reversal.
            </p>
          </>
        )}
      </Section>
    </>
  );
}

'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { INVOICE_PAYMENT_METHODS } from '@/lib/labels';

/**
 * Issuing, with the one choice that has to be made at that moment.
 *
 * The mode de règlement is asked for here rather than on the draft because it
 * is a statement about how this invoice will be settled, and it becomes part
 * of a document that is read-only from the instant it has a number.
 *
 * Nothing here decides whether the document may be issued. The ICE and the
 * mode de règlement are both conditions inside app.issue_document, and the
 * error it raises is what gets shown — so the rule has one home and the form
 * cannot drift from it or be stepped around.
 */
export function IssueForm({
  action,
  documentId,
  docType,
  typeLabel,
  hasLines,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  documentId: string;
  docType: string;
  typeLabel: string;
  hasLines: boolean;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);
  const isInvoice = docType !== 'devis';

  return (
    <>
      <ErrorBanner message={state.error} />
      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="documentId" value={documentId} />

        {isInvoice && (
          <label className="block" htmlFor="paymentMethod">
            <span className="label block">Mode de règlement</span>
            <select
              id="paymentMethod"
              name="paymentMethod"
              className="input w-56"
              defaultValue=""
            >
              <option value="">Choose…</option>
              {INVOICE_PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block" htmlFor="confirmation">
          <span className="label block">Type ISSUE to confirm</span>
          <input id="confirmation" name="confirmation" autoComplete="off" className="input w-48" />
        </label>

        <Submit label={`Issue ${typeLabel}`} disabled={!hasLines} />
      </form>

      {isInvoice && (
        <p className="hint mt-2">
          Article 145 of the CGI requires the client&apos;s ICE and the mode de règlement
          on an invoice. Both are checked when it is issued.
        </p>
      )}
    </>
  );
}

function Submit({ label, disabled }: { label: string; disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending || disabled}>
      {pending ? 'Issuing…' : label}
    </button>
  );
}

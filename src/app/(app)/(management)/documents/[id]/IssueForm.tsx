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
  needsIceWaiver,
  clientName,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  documentId: string;
  docType: string;
  typeLabel: string;
  hasLines: boolean;
  /**
   * The client cannot supply an ICE and is not a private individual — so this
   * invoice can only be issued by waiving article 145 in writing.
   */
  needsIceWaiver: boolean;
  clientName: string;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);
  const isInvoice = docType !== 'devis';
  const offerWaiver = isInvoice && needsIceWaiver;

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

        {offerWaiver && (
          <label className="block w-full" htmlFor="iceWaiverReason">
            <span className="label block">
              Issue without {clientName}&apos;s ICE — write why
            </span>
            <input
              id="iceWaiverReason"
              name="iceWaiverReason"
              autoComplete="off"
              className="input"
              placeholder="e.g. Client is registering; ICE promised before the end of the month"
            />
          </label>
        )}

        <Submit label={`Issue ${typeLabel}`} disabled={!hasLines} />
      </form>

      {isInvoice && !offerWaiver && (
        <p className="hint mt-2">
          Article 145 of the CGI requires the client&apos;s ICE and the mode de règlement
          on an invoice. Both are checked when it is issued.
        </p>
      )}

      {offerWaiver && (
        <div className="tone-warn mt-3 rounded-[10px] px-4 py-3">
          <p className="text-[12.5px] font-bold tracking-wide uppercase">
            This invoice will not conform to article 145
          </p>
          <p className="prose-vixart mt-1">
            {clientName} has no ICE on file. Adding it is the right fix. Issuing
            anyway is possible — only for an administrator, only with a written
            reason — and the invoice will print{' '}
            <span className="font-semibold">ICE — non renseigné —</span> where the
            client&apos;s number belongs. Your name and your reason are recorded on
            the document and in the activity log, which cannot be edited.
          </p>
        </div>
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

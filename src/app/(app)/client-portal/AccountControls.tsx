'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE } from '@/lib/form-state';
import { reissueClientPasswordAction } from '../companies/client-access-actions';
import { setClientActiveAction } from './actions';

function Pending({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="text-[13.5px] underline underline-offset-2" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

/**
 * A new password for somebody locked out.
 *
 * The same action the company page uses, not a second one: it generates the
 * password, sets the expiry and writes the email in one place, and a copy here
 * would drift in exactly the part nobody reads — how strong the password is and
 * how long it lives.
 */
export function ReissueForm({ contactId }: { contactId: string }) {
  const [state, formAction] = useActionState(reissueClientPasswordAction, EMPTY_STATE);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="contactId" value={contactId} />
      <Pending label="Email a new password" busy="Sending…" />
      {state.error && (
        <span role="alert" className="ml-2 text-[12.5px] text-danger">
          {state.error}
        </span>
      )}
    </form>
  );
}

/**
 * Turning an account off, never deleting it.
 *
 * What that person wrote in their support conversation is a record of what was
 * said, and `message.author_contact_id` points at the contact. Deactivating
 * stops the sign-in and leaves the conversation whole.
 */
export function DeactivateButton({
  contactId,
  active,
}: {
  contactId: string;
  active: boolean;
}) {
  return (
    <form action={setClientActiveAction} className="inline">
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="active" value={active ? '0' : '1'} />
      <Pending
        label={active ? 'Turn off' : 'Turn back on'}
        busy={active ? 'Turning off…' : 'Turning on…'}
      />
    </form>
  );
}

'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE } from '@/lib/form-state';
import {
  openClientAccountAction,
  reissueClientPasswordAction,
  setClientAccountActiveAction,
} from '../client-access-actions';

interface Person {
  id: string;
  fullName: string;
  email: string | null;
}

interface Account {
  contact_id: string;
  is_active: boolean;
  must_change_password: boolean;
  last_sign_in_at: string | null;
  initial_password_expires_at: string | null;
}

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

/**
 * Opening and managing client sign-ins for one company.
 *
 * The generated password is NOT shown here. It goes to the client's own
 * mailbox and nowhere else — putting it on this screen as well would mean it
 * lived in a browser tab, a screenshot and whatever is behind the person
 * sitting at the desk. If it does not arrive, reissue it.
 */
export function ClientAccess({
  companyId,
  contacts,
  accounts,
}: {
  companyId: string;
  contacts: Person[];
  accounts: Account[];
}) {
  const [openState, openAction] = useActionState(openClientAccountAction, EMPTY_STATE);
  const [reissueState, reissueAction] = useActionState(reissueClientPasswordAction, EMPTY_STATE);

  const byContact = new Map(accounts.map((a) => [a.contact_id, a]));
  const withoutAccount = contacts.filter((c) => !byContact.has(c.id));

  return (
    <>
      <p className="prose-vixart" style={{ opacity: 0.68 }}>
        A client account lets this person sign in to see their own projects and
        write to us. They see nothing belonging to any other client — not the
        team’s channels, not the other work on our books.
      </p>

      {(openState.error || reissueState.error) && (
        <p role="alert" className="tone-danger mt-4 rounded-[10px] px-4 py-3">
          {openState.error ?? reissueState.error}
        </p>
      )}

      {accounts.length > 0 && (
        <ul className="mt-5 border-t border-void/10">
          {contacts
            .filter((c) => byContact.has(c.id))
            .map((person) => {
              const account = byContact.get(person.id)!;
              return (
                <li key={person.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-void/10 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{person.fullName}</p>
                    <p className="hint">
                      {person.email}
                      {' · '}
                      {!account.is_active
                        ? 'Closed'
                        : account.must_change_password
                          ? 'Invited, not signed in yet'
                          : account.last_sign_in_at
                            ? `Last signed in ${new Date(account.last_sign_in_at).toLocaleDateString('en-GB')}`
                            : 'Active'}
                    </p>
                  </div>

                  <form action={reissueAction}>
                    <input type="hidden" name="contactId" value={person.id} />
                    <Submit label="Send a new password" busy="Sending…" />
                  </form>

                  <form action={setClientAccountActiveAction}>
                    <input type="hidden" name="contactId" value={person.id} />
                    <input type="hidden" name="companyId" value={companyId} />
                    <input type="hidden" name="active" value={account.is_active ? '0' : '1'} />
                    <button type="submit" className="btn btn-inverse">
                      {account.is_active ? 'Close access' : 'Reopen'}
                    </button>
                  </form>
                </li>
              );
            })}
        </ul>
      )}

      {withoutAccount.length > 0 ? (
        <form action={openAction} className="mt-6 flex flex-wrap items-end gap-3">
          <label className="block" htmlFor="contactId">
            <span className="label block" style={{ opacity: 0.68 }}>Open an account for</span>
            <select id="contactId" name="contactId" required className="input mt-1.5 w-64">
              <option value="">Choose a contact…</option>
              {withoutAccount.map((c) => (
                <option key={c.id} value={c.id} disabled={!c.email}>
                  {c.fullName}
                  {c.email ? '' : ' — no email address'}
                </option>
              ))}
            </select>
          </label>
          <Submit label="Open account and send invitation" busy="Opening…" />
        </form>
      ) : (
        contacts.length > 0 && (
          <p className="hint mt-6">Every contact here already has an account.</p>
        )
      )}

      {contacts.length === 0 && (
        <p className="hint mt-6">Add a contact with an email address first.</p>
      )}
    </>
  );
}

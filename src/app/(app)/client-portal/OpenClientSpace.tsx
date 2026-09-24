'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, NoticeBanner, TextInput } from '@/components/ui';
import { EMPTY_STATE } from '@/lib/form-state';
import { openClientSpaceAction } from './actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Opening…' : 'Open the account and email the invitation'}
    </button>
  );
}

/**
 * One client, one submit.
 *
 * The generated password is NOT shown on this screen and never will be. It
 * goes to the client's own mailbox and nowhere else — putting it here as well
 * would mean it lived in a browser tab, in a screenshot, and in front of
 * whoever is standing behind the desk. If it does not arrive, reissue it.
 */
export function OpenClientSpace({
  companies,
}: {
  companies: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [state, formAction] = useActionState(openClientSpaceAction, EMPTY_STATE);

  /*
   * An existing client, or a new one.
   *
   * A select with a "new client…" option and a text field that appears, rather
   * than two forms: the decision is one thing — which client is this for — and
   * splitting it into two places is how somebody types a name that already
   * exists and ends up with the same company twice.
   */
  const [companyId, setCompanyId] = useState('');
  const isNew = companyId === '';

  return (
    <form action={formAction}>
      <ErrorBanner message={state.error} />
      <NoticeBanner message={state.notice} />

      <FormGrid>
        <label className="block" htmlFor="companyId">
          <span className="label block">Client</span>
          <select
            id="companyId"
            name="companyId"
            value={companyId}
            onChange={(e) => setCompanyId(e.currentTarget.value)}
            className="mt-2 w-full rounded-[10px] border border-void/15 bg-paper px-3.5 py-2.5 text-[15px]"
          >
            <option value="">A client not on our books yet…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {isNew ? (
          <TextInput
            name="companyName"
            label="New client’s name"
            required
            placeholder="Talborjt Lab"
          />
        ) : (
          <div className="hidden sm:block" />
        )}

        <TextInput
          name="fullName"
          label="Who signs in"
          required
          placeholder="Hassan Ait Ali"
        />

        <TextInput
          name="email"
          label="Their email"
          type="email"
          required
          placeholder="hassan@talborjtlab.com"
          hint="The password is emailed here, and expires in seven days if it is never used."
        />

        <TextInput
          name="projectName"
          label="First project"
          placeholder="Brand film — winter"
          hint={
            isNew
              ? 'What they will watch the progress of. Required for a new client — a portal with no project in it says nothing.'
              : 'Leave it empty to use the projects this client already has. Type a name to add one.'
          }
          required={isNew}
        />
      </FormGrid>

      <div className="mt-6">
        <Submit />
      </div>
    </form>
  );
}

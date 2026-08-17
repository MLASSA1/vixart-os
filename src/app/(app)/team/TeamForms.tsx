'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, FormGrid, Select, TextInput } from '@/components/ui';
import { EMPTY_TEAM_STATE, type TeamState } from '@/lib/form-state';

const ROLE_OPTIONS = [
  { value: 'member', label: 'Team — own work, clients, projects' },
  { value: 'moderator', label: 'Moderator — assigns work and signs it off' },
  { value: 'admin', label: 'Administrator — everything, including Finance' },
];

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

/**
 * The generated password, shown once.
 *
 * It is never stored in readable form, so if this is missed it has to be reset
 * rather than looked up. The panel says so rather than letting someone assume
 * they can find it again later.
 */
function PasswordHandover({ state }: { state: TeamState }) {
  if (!state.createdPassword) return null;
  return (
    <div className="mb-5 border-2 border-void px-4 py-3">
      <p className="font-semibold">Initial password for {state.createdFor}</p>
      <p className="code mt-2 text-lg font-bold">{state.createdPassword}</p>
      <p className="hint mt-2">
        Shown once and never stored in readable form. Send it to them now — if you
        lose it, use “Reset password” to issue a new one. They must change it before
        they can reach anything.
      </p>
    </div>
  );
}

export function AddMemberForm({
  action,
}: {
  action: (state: TeamState, formData: FormData) => Promise<TeamState>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: TeamState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_TEAM_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="border border-void/25 p-5">
      <PasswordHandover state={state} />
      <ErrorBanner message={state.error} />
      <FormGrid>
        <TextInput name="fullName" label="Name" required placeholder="Yassine" />
        <TextInput
          name="email"
          label="Email"
          type="email"
          required
          placeholder="yassine@vixart.ma"
        />
        <TextInput name="jobTitle" label="Role in the agency" placeholder="Motion Designer" />
        <Select name="role" label="Access" required defaultValue="member" options={ROLE_OPTIONS} />
      </FormGrid>
      <div className="mt-5">
        <Submit label="Create account" busy="Creating…" />
      </div>
      <p className="hint mt-3">
        An initial password is generated and shown once. They must change it on
        first sign-in.
      </p>
    </form>
  );
}

export function EditMemberForm({
  action,
  fullName,
  jobTitle,
}: {
  action: (state: TeamState, formData: FormData) => Promise<TeamState>;
  fullName: string;
  jobTitle: string | null;
}) {
  const [state, formAction] = useActionState(action, EMPTY_TEAM_STATE);
  return (
    <form action={formAction} className="mt-3">
      <ErrorBanner message={state.error} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block" htmlFor={`name-${fullName}`}>
          <span className="label block">Name</span>
          <input id={`name-${fullName}`} name="fullName" defaultValue={fullName} className="input w-52" required />
        </label>
        <label className="block flex-1" htmlFor={`job-${fullName}`}>
          <span className="label block">Role in the agency</span>
          <input id={`job-${fullName}`} name="jobTitle" defaultValue={jobTitle ?? ''} className="input" />
        </label>
        <Submit label="Save" busy="Saving…" />
      </div>
    </form>
  );
}

export function ResetPasswordForm({
  action,
}: {
  action: (state: TeamState, formData: FormData) => Promise<TeamState>;
}) {
  const [state, formAction] = useActionState(action, EMPTY_TEAM_STATE);
  return (
    <form action={formAction} className="mt-3">
      <PasswordHandover state={state} />
      <ErrorBanner message={state.error} />
      <button type="submit" className="btn btn-inverse btn-small">
        Reset password
      </button>
    </form>
  );
}

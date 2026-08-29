'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { changePasswordAction, type PasswordState } from './actions';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

const INITIAL: PasswordState = { error: null };

export function PasswordForm({ label = 'Change password' }: { label?: string }) {
  const [state, formAction] = useActionState(changePasswordAction, INITIAL);

  return (
    <form action={formAction} className="mt-6 max-w-md space-y-5">
      {state.error && (
        <div role="alert" className="border-2 border-void bg-void px-4 py-3 text-pure">
          <p className="label">Refused</p>
          <p className="mt-1">{state.error}</p>
        </div>
      )}

      <label className="block" htmlFor="password">
        <span className="label block" style={{ opacity: 0.68 }}>
          New password
        </span>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="input mt-1.5"
        />
        <span className="mt-1 block text-[15px]" style={{ opacity: 0.52 }}>
          12 characters minimum.
        </span>
      </label>

      <label className="block" htmlFor="confirmation">
        <span className="label block" style={{ opacity: 0.68 }}>
          Confirm password
        </span>
        <input
          id="confirmation"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="input mt-1.5"
        />
      </label>

      <SubmitButton label={label} />
    </form>
  );
}

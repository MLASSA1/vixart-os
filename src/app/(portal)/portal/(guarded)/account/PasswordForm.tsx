'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE } from '@/lib/form-state';
import { setClientPasswordAction } from './actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function ClientPasswordForm({ label }: { label: string }) {
  const [state, formAction] = useActionState(setClientPasswordAction, EMPTY_STATE);

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-5">
      {state.error && (
        <p role="alert" className="tone-danger rounded-[10px] px-4 py-3">{state.error}</p>
      )}
      {state.notice && (
        <p role="status" className="tone-ok rounded-[10px] px-4 py-3">{state.notice}</p>
      )}

      <label className="block" htmlFor="password">
        <span className="label block" style={{ opacity: 0.68 }}>New password</span>
        <input id="password" name="password" type="password" autoComplete="new-password"
               required minLength={12} className="input mt-1.5" />
        <span className="hint mt-1 block">12 characters minimum.</span>
      </label>

      <label className="block" htmlFor="confirm">
        <span className="label block" style={{ opacity: 0.68 }}>Confirm password</span>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password"
               required minLength={12} className="input mt-1.5" />
      </label>

      <Submit label={label} />
    </form>
  );
}

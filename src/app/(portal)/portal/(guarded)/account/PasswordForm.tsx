'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE } from '@/lib/form-state';
import { setClientPasswordAction } from './actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="vix-btn mt-2" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function ClientPasswordForm({ label }: { label: string }) {
  const [state, formAction] = useActionState(setClientPasswordAction, EMPTY_STATE);

  return (
    <form action={formAction} className="mt-8 max-w-[380px] space-y-5">
      {state.error && <p role="alert" className="vix-alert">{state.error}</p>}
      {state.notice && <p role="status" className="vix-alert">{state.notice}</p>}

      <label className="block" htmlFor="password">
        <span className="vix-meta block">New password</span>
        <input id="password" name="password" type="password" autoComplete="new-password"
               required minLength={12} className="vix-input mt-2" />
        <span className="vix-quiet mt-2 block">12 characters minimum.</span>
      </label>

      <label className="block" htmlFor="confirm">
        <span className="vix-meta block">Confirm password</span>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password"
               required minLength={12} className="vix-input mt-2" />
      </label>

      <Submit label={label} />
    </form>
  );
}

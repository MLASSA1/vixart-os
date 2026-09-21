'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { clientSignInAction, type SignInState } from './actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="vix-btn mt-2 w-full" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}

const INITIAL: SignInState = { error: null };

export function ClientSignInForm() {
  const [state, formAction] = useActionState(clientSignInAction, INITIAL);

  return (
    <form action={formAction} className="mt-7 space-y-5">
      {state.error && (
        <div role="alert" className="vix-alert">
          <p className="vix-meta">Sign-in refused</p>
          <p className="mt-1.5">{state.error}</p>
        </div>
      )}

      <label className="block" htmlFor="email">
        <span className="vix-meta block">Email address</span>
        <input id="email" name="email" type="email" autoComplete="username"
               required autoFocus className="vix-input mt-2" />
      </label>

      <label className="block" htmlFor="password">
        <span className="vix-meta block">Password</span>
        <input id="password" name="password" type="password" autoComplete="current-password"
               required className="vix-input mt-2" />
      </label>

      <SubmitButton />
    </form>
  );
}

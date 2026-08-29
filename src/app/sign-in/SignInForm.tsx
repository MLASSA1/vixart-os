'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signInAction, type SignInState } from './actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn w-full" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}

const INITIAL: SignInState = { error: null };

export function SignInForm() {
  const [state, formAction] = useActionState(signInAction, INITIAL);

  return (
    <form action={formAction} className="mt-6 space-y-5">
      {state.error && (
        <div
          role="alert"
          className="tone-danger rounded-[10px] px-4 py-3"
        >
          <p className="text-[12.5px] font-bold tracking-wide uppercase">Sign-in refused</p>
          <p className="mt-1">{state.error}</p>
        </div>
      )}

      <label className="block" htmlFor="email">
        <span className="label block" style={{ opacity: 0.68 }}>
          Email address
        </span>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className="input mt-1.5"
        />
      </label>

      <label className="block" htmlFor="password">
        <span className="label block" style={{ opacity: 0.68 }}>
          Password
        </span>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input mt-1.5"
        />
      </label>

      <SubmitButton />
    </form>
  );
}

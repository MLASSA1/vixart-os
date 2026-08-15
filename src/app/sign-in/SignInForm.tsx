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
    <form action={formAction} className="mt-10 space-y-5">
      {state.error && (
        <div
          role="alert"
          className="border-2 border-void bg-void px-4 py-3 text-pure"
        >
          <p className="meta">Sign-in refused</p>
          <p className="mt-1">{state.error}</p>
        </div>
      )}

      <label className="block" htmlFor="email">
        <span className="meta block" style={{ opacity: 0.68 }}>
          Email address
        </span>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className="mt-1.5 w-full border border-void bg-pure px-3 py-2.5 text-[15px] focus:border-[3px] focus:px-[10px] focus:py-[8px] focus:outline-none"
        />
      </label>

      <label className="block" htmlFor="password">
        <span className="meta block" style={{ opacity: 0.68 }}>
          Password
        </span>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1.5 w-full border border-void bg-pure px-3 py-2.5 text-[15px] focus:border-[3px] focus:px-[10px] focus:py-[8px] focus:outline-none"
        />
      </label>

      <SubmitButton />
    </form>
  );
}

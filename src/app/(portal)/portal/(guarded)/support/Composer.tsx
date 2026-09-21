'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE } from '@/lib/form-state';
import { sendSupportMessageAction } from './actions';

function SendButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="vix-btn" disabled={pending}>
      {pending ? 'Sending…' : 'Send'}
    </button>
  );
}

export function SupportComposer() {
  const [state, formAction] = useActionState(sendSupportMessageAction, EMPTY_STATE);
  const form = useRef<HTMLFormElement>(null);

  // Cleared once it has actually gone, and not before: a form that empties
  // itself on submit loses what you wrote when the send fails.
  useEffect(() => {
    if (!state.error) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction} className="vix-rule mt-10 border-t pt-8">
      {state.error && (
        <p role="alert" className="vix-alert mb-5">{state.error}</p>
      )}
      <label className="block" htmlFor="body">
        <span className="vix-meta block">Write to the team</span>
        <textarea
          id="body"
          name="body"
          rows={4}
          required
          maxLength={4000}
          placeholder="Ask us anything about your work."
          className="vix-input mt-3"
        />
      </label>
      <div className="mt-4 flex justify-end">
        <SendButton />
      </div>
    </form>
  );
}

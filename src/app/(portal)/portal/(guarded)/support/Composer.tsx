'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { sendSupportMessageAction } from './actions';

function SendButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Sending…' : 'Send'}
    </button>
  );
}

export function SupportComposer() {
  const [state, formAction] = useActionState(sendSupportMessageAction, EMPTY_STATE);
  const form = useRef<HTMLFormElement>(null);

  // Clear the box once it has actually gone, and not before: a form that
  // empties itself on submit loses what you wrote when the send fails.
  useEffect(() => {
    if (state === EMPTY_STATE || (!state.error && state !== EMPTY_STATE)) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction} className="mt-6">
      {state.error && (
        <p role="alert" className="tone-danger mb-3 rounded-[10px] px-4 py-3">{state.error}</p>
      )}
      <label className="block" htmlFor="body">
        <span className="label block" style={{ opacity: 0.68 }}>Write to the team</span>
        <textarea
          id="body"
          name="body"
          rows={4}
          required
          maxLength={4000}
          placeholder="Ask us anything about your work."
          className="input mt-1.5 w-full"
        />
      </label>
      <div className="mt-3 flex justify-end">
        <SendButton />
      </div>
    </form>
  );
}

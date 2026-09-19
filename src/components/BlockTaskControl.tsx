'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Saying a task is stuck, and on what.
 *
 * Its own client component because it is the one task control that can fail
 * for a reason worth reading: the database refuses `blocked` without a reason,
 * and TaskRow is a server component with nowhere to put that message.
 *
 * A details element rather than a button. Writing the reason IS the action —
 * a one-click "blocked" would produce exactly the silent dead end this state
 * exists to prevent.
 */
export function BlockTaskControl({
  action,
  taskId,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  taskId: string;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  return (
    <details className="inline-block">
      <summary className="btn btn-inverse btn-small cursor-pointer list-none">Blocked</summary>
      <form action={formAction} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <input
          name="blockedReason"
          required
          minLength={3}
          className="input mt-0 w-64"
          placeholder="Waiting on the client to send the logo"
          aria-label="What it is waiting on"
        />
        <Submit />
      </form>
      {state.error && (
        <p className="tone-danger mt-1 inline-block rounded-[8px] px-2.5 py-1 text-[13px]">
          {state.error}
        </p>
      )}
      <p className="hint mt-1 text-[12px]">
        Whoever raised this is told, with your reason.
      </p>
    </details>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-small" disabled={pending}>
      {pending ? 'Saving…' : 'Mark blocked'}
    </button>
  );
}

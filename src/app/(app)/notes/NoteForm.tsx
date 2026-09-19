'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

export function NoteForm({
  action,
  note,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  /** Absent when writing a new one. */
  note?: { id: string; title: string; body: string };
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error && !note) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className={note ? '' : 'card px-5 py-4'}>
      <ErrorBanner message={state.error} />
      {note && <input type="hidden" name="noteId" value={note.id} />}
      <input
        name="title"
        required
        defaultValue={note?.title}
        className="input mt-0 font-semibold"
        placeholder="Title"
        aria-label="Title"
      />
      <textarea
        name="body"
        rows={note ? 6 : 4}
        defaultValue={note?.body}
        className="input mt-2"
        placeholder="Whatever it is, before it is ready to be said out loud."
        aria-label="Note"
      />
      <div className="mt-2 flex items-center gap-3">
        <Submit label={note ? 'Save' : 'Write it down'} />
        {!note && (
          <span className="hint">
            Only you can read this — not a moderator, not an administrator.
          </span>
        )}
      </div>
    </form>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

export interface CommentItem {
  id: string;
  author_name: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Posting…' : 'Post comment'}
    </button>
  );
}

/**
 * Internal thread. Everyone on the team reads it; you post in your own name,
 * which the RLS policy enforces rather than trusting the form.
 */
export function Comments({
  items,
  addAction,
  deleteAction,
  currentUserId,
  canModerate,
}: {
  items: CommentItem[];
  addAction: (state: FormState, formData: FormData) => Promise<FormState>;
  deleteAction: (formData: FormData) => Promise<void>;
  currentUserId: string;
  canModerate: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await addAction(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <div>
      {items.length === 0 ? (
        <p className="hint">No comment yet.</p>
      ) : (
        <ul className="border-t border-void/10">
          {items.map((c) => (
            <li key={c.id} className="border-b border-void/10 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="font-medium">{c.author_name}</span>
                <span className="hint">{formatDateTime(c.created_at)}</span>
              </div>
              <p className="prose-vixart mt-1 whitespace-pre-wrap">{c.body}</p>
              {(canModerate || c.author_id === currentUserId) && (
                <form action={deleteAction} className="mt-1">
                  <input type="hidden" name="commentId" value={c.id} />
                  <button
                    type="submit"
                    className="hint cursor-pointer underline underline-offset-4"
                  >
                    Delete
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <form ref={formRef} action={formAction} className="mt-4">
        <ErrorBanner message={state.error} />
        <label className="block" htmlFor="body">
          <span className="label block">Add a comment</span>
          <textarea
            id="body"
            name="body"
            rows={3}
            required
            className="input"
            placeholder="Something the rest of the team should know…"
          />
        </label>
        <div className="mt-3">
          <Submit />
        </div>
      </form>
    </div>
  );
}

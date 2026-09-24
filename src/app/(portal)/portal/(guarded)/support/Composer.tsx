'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { EMPTY_STATE } from '@/lib/form-state';
import { allowedTypesForInput, formatBytes, MAX_UPLOAD_BYTES } from '@/lib/upload-types';
import { sendSupportMessageAction } from './actions';

function SendButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="vix-btn" disabled={pending || disabled}>
      {pending ? 'Sending…' : 'Send'}
    </button>
  );
}

export function SupportComposer() {
  const [state, formAction] = useActionState(sendSupportMessageAction, EMPTY_STATE);
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * The chosen file, named on screen before it is sent.
   *
   * A bare file input says "No file chosen" in the browser's own grey, at the
   * browser's own size, and a client who picked the wrong photograph has no
   * way to notice. Holding the name in state also gives them a way to take it
   * back off the message without reloading the page.
   */
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null);
  const tooBig = chosen !== null && chosen.size > MAX_UPLOAD_BYTES;

  // Cleared once it has actually gone, and not before: a form that empties
  // itself on submit loses what you wrote when the send fails.
  useEffect(() => {
    if (!state.error) {
      form.current?.reset();
      setChosen(null);
    }
  }, [state]);

  function drop() {
    if (fileInput.current) fileInput.current.value = '';
    setChosen(null);
  }

  return (
    <form ref={form} action={formAction} className="vix-rule mt-10 border-t pt-8">
      {state.error && (
        <p role="alert" className="vix-alert mb-5">{state.error}</p>
      )}
      {/*
        A notice is not a failure. It is the case where the message arrived and
        the file did not, and saying so is the whole point — otherwise a client
        believes we have a photograph we have never seen.
      */}
      {state.notice && !state.error && (
        <p role="status" className="vix-alert mb-5">{state.notice}</p>
      )}

      <label className="block" htmlFor="body">
        <span className="vix-meta block">Write to the team</span>
        <textarea
          id="body"
          name="body"
          rows={4}
          maxLength={4000}
          placeholder="Ask us anything about your work."
          className="vix-input mt-3"
        />
      </label>

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <label
          className="cursor-pointer px-4 py-2.5 text-[13.5px] font-semibold"
          style={{ border: '1px solid var(--vix-line)', borderRadius: 2 }}
        >
          Attach a file
          <input
            ref={fileInput}
            type="file"
            name="file"
            // A convenience, never the control: the server checks the type and
            // the size again whatever the browser was told to allow.
            accept={allowedTypesForInput()}
            className="hidden"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              setChosen(f ? { name: f.name, size: f.size } : null);
            }}
          />
        </label>

        {chosen && (
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="truncate">{chosen.name}</span>
            <span className="vix-quiet">{formatBytes(chosen.size)}</span>
            <button
              type="button"
              onClick={drop}
              className="underline underline-offset-2"
              aria-label={`Remove ${chosen.name}`}
            >
              remove
            </button>
          </span>
        )}
      </div>

      {tooBig && (
        <p role="alert" className="vix-alert mt-4">
          That file is {formatBytes(chosen.size)}. The limit is{' '}
          {formatBytes(MAX_UPLOAD_BYTES)} — send a smaller one, or a link to it.
        </p>
      )}

      <p className="vix-quiet mt-4">
        Photos, video, PDFs and documents. Up to {formatBytes(MAX_UPLOAD_BYTES)}.
      </p>

      <div className="mt-5 flex justify-end">
        <SendButton disabled={tooBig} />
      </div>
    </form>
  );
}

'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, NoticeBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { ALLOWED_SUMMARY, allowedTypesForInput, formatBytes, MAX_UPLOAD_BYTES } from '@/lib/upload-types';

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

export function NewThreadForm({
  action,
  companies,
  projects,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  companies: ReadonlyArray<{ id: string; name: string }>;
  projects: ReadonlyArray<{ id: string; label: string }>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<'general' | 'company' | 'project'>('general');
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="rounded-xl border border-void/15 p-5">
      <ErrorBanner message={state.error} />

      <div className="mb-4 flex flex-wrap gap-2">
        {(['general', 'company', 'project'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`btn btn-small ${kind === k ? '' : 'btn-inverse'}`}
          >
            {k === 'general' ? 'The agency' : k === 'company' ? 'About a client' : 'About a project'}
          </button>
        ))}
      </div>
      <input type="hidden" name="kind" value={kind} />

      <div className="grid gap-4 sm:grid-cols-12">
        <label className="block sm:col-span-7">
          <span className="label block">What is it about</span>
          <input
            name="title"
            required
            className="input"
            placeholder={
              kind === 'general' ? 'Studio kit — what needs replacing' : 'Shoot planning'
            }
          />
        </label>

        {kind !== 'general' && (
          <label className="block sm:col-span-5">
            <span className="label block">{kind === 'company' ? 'Client' : 'Project'}</span>
            <select name="targetId" required className="input" defaultValue="">
              <option value="">Choose…</option>
              {(kind === 'company'
                ? companies.map((c) => ({ id: c.id, label: c.name }))
                : projects
              ).map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Submit label="Start the thread" busy="Creating…" />
        <span className="hint">
          {kind === 'general'
            ? 'Everyone on the team can read it.'
            : 'Whoever can see that record can read it.'}
        </span>
      </div>
    </form>
  );
}

/** Post a message, with an optional file. */
export function PostMessageForm({
  action,
  mentionable,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  /**
   * People who can actually open THIS thread. The server computed it; the
   * picker only offers what it was given, and the server checks again anyway
   * — this list is a convenience, not the rule.
   */
  mentionable: ReadonlyArray<{ id: string; fullName: string }>;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) {
        formRef.current?.reset();
        setFileName(null);
        setTooBig(false);
      }
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <form ref={formRef} action={formAction} className="card px-5 py-4">
      <ErrorBanner message={state.error} />
      <NoticeBanner message={state.notice} />

      <textarea
        ref={bodyRef}
        name="body"
        rows={3}
        className="input mt-0"
        placeholder="Write to the team…"
      />

      {mentionable.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="hint">Mention:</span>
          {mentionable.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn-inverse btn-small"
              onClick={() => {
                const el = bodyRef.current;
                if (!el) return;
                // Written into the text, because the text is what the server
                // reads. Nothing about who was mentioned travels separately.
                const sep = el.value && !el.value.endsWith(' ') ? ' ' : '';
                el.value = `${el.value}${sep}@${p.fullName} `;
                el.focus();
              }}
            >
              @{p.fullName}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="hint cursor-pointer underline underline-offset-4">
          Attach a file
          <input
            type="file"
            name="file"
            accept={allowedTypesForInput()}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setFileName(f ? f.name : null);
              // The browser check is a courtesy. The server refuses it too,
              // which is the one that counts.
              setTooBig(Boolean(f && f.size > MAX_UPLOAD_BYTES));
            }}
          />
        </label>

        {fileName && (
          <span className={`chip ${tooBig ? 'tone-danger' : 'tone-quiet'}`}>
            {fileName}
            {tooBig ? ` — over ${formatBytes(MAX_UPLOAD_BYTES)}` : ''}
          </span>
        )}

        <span className="ml-auto">
          <Submit label="Send" busy="Sending…" />
        </span>
      </div>

      <p className="hint mt-2">{ALLOWED_SUMMARY}</p>
    </form>
  );
}

/** Correct a typo, inside the window. */
export function EditMessageForm({
  action,
  messageId,
  body,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  messageId: string;
  body: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  if (!open) {
    return (
      <button
        type="button"
        className="hint cursor-pointer underline underline-offset-4"
        onClick={() => setOpen(true)}
      >
        Correct
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-2 w-full">
      <ErrorBanner message={state.error} />
      <input type="hidden" name="messageId" value={messageId} />
      <textarea name="body" rows={2} className="input mt-0" defaultValue={body} />
      <div className="mt-2 flex items-center gap-3">
        <Submit label="Save" busy="Saving…" />
        <button
          type="button"
          className="hint cursor-pointer underline underline-offset-4"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

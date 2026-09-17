'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, NoticeBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { Avatar } from './ChatBits';
import {
  ALLOWED_SUMMARY,
  allowedTypesForInput,
  formatBytes,
  MAX_UPLOAD_BYTES,
} from '@/lib/upload-types';

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Opening a channel by hand
// ---------------------------------------------------------------------------

/**
 * Only shown to admins and moderators — and refused by `thread_insert` for
 * anyone else, which is the part that counts.
 *
 * The name defaults to whatever it is attached to, because that is the name
 * nine times out of ten. It stays editable for the tenth.
 */
export function NewChannelForm({
  action,
  targets,
  onDone,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  targets: ReadonlyArray<{ id: string; name: string; kind: 'company' | 'project' }>;
  onDone: () => void;
}) {
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [touched, setTouched] = useState(false);

  const [state, formAction] = useActionState(async (previous: FormState, formData: FormData) => {
    const result = await action(previous, formData);
    if (!result.error) onDone();
    return result;
  }, EMPTY_STATE);

  const chosen = targets.find((t) => t.id === target);

  return (
    <form action={formAction} className="rounded-xl border border-void/15 bg-surface p-3">
      <ErrorBanner message={state.error} />

      <label className="block">
        <span className="label block text-[12px]">About</span>
        <select
          name="targetId"
          required
          className="input mt-1 py-1.5 text-[13.5px]"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            const next = targets.find((t) => t.id === e.target.value);
            // Only while the field is still the one we filled in.
            if (!touched) setTitle(next?.name ?? '');
          }}
        >
          <option value="">Choose a project or client…</option>
          <optgroup label="Projects">
            {targets
              .filter((t) => t.kind === 'project')
              .map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
          </optgroup>
          <optgroup label="Clients">
            {targets
              .filter((t) => t.kind === 'company')
              .map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
          </optgroup>
        </select>
      </label>

      <input type="hidden" name="kind" value={chosen?.kind ?? ''} />

      <label className="mt-2 block">
        <span className="label block text-[12px]">Called</span>
        <input
          name="title"
          required
          value={title}
          onChange={(e) => {
            setTouched(true);
            setTitle(e.target.value);
          }}
          className="input mt-1 py-1.5 text-[13.5px]"
          placeholder="Name it"
        />
      </label>

      <div className="mt-3 flex items-center gap-2">
        <Submit label="Open" busy="Opening…" />
        <button
          type="button"
          onClick={onDone}
          className="hint cursor-pointer underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
      <p className="hint mt-2 text-[12px]">
        Whoever can see that record can read it.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/**
 * Writing a message, with the @ picker.
 *
 * The picker is a convenience over the parser, never a replacement for it: what
 * gets sent is the text, and the server re-reads it against the people who can
 * actually open this channel. Choosing a name here writes the name into the
 * box, and nothing about who was picked travels separately — so a tampered
 * request cannot mention somebody into a conversation they are not allowed to
 * see, because there is nothing to tamper with.
 */
export function Composer({
  action,
  mentionable,
  dropped,
  onDropConsumed,
  onSent,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  mentionable: ReadonlyArray<{ id: string; fullName: string }>;
  /** A file dragged onto the message pane, handed over to be attached. */
  dropped: File | null;
  onDropConsumed: () => void;
  onSent: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const [state, formAction] = useActionState(async (previous: FormState, formData: FormData) => {
    const result = await action(previous, formData);
    if (!result.error) {
      formRef.current?.reset();
      setFileName(null);
      setTooBig(false);
      setQuery(null);
      onSent();
    }
    return result;
  }, EMPTY_STATE);

  // A dropped file is put into the real input, so it travels with the form like
  // any other and the server sees no difference between dragging and browsing.
  useEffect(() => {
    if (!dropped || !fileRef.current) return;
    const bag = new DataTransfer();
    bag.items.add(dropped);
    fileRef.current.files = bag.files;
    setFileName(dropped.name);
    setTooBig(dropped.size > MAX_UPLOAD_BYTES);
    onDropConsumed();
  }, [dropped, onDropConsumed]);

  const matches =
    query === null
      ? []
      : mentionable
          .filter((p) => p.fullName.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 6);
  const picking = query !== null && matches.length > 0;

  /** The part between the last unfinished "@" and the caret, if there is one. */
  function readQuery(el: HTMLTextAreaElement) {
    const upto = el.value.slice(0, el.selectionStart);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;
    const fragment = upto.slice(at + 1);
    // Names contain spaces, so a space cannot end it — but a newline does, and
    // so does writing more than any name is long.
    if (fragment.includes('\n') || fragment.length > 32) return null;
    // An address is not a mention.
    if (at > 0 && /\S/.test(upto[at - 1] ?? '')) return null;
    return fragment;
  }

  function choose(fullName: string) {
    const el = bodyRef.current;
    if (!el) return;
    const upto = el.value.slice(0, el.selectionStart);
    const at = upto.lastIndexOf('@');
    if (at === -1) return;
    const after = el.value.slice(el.selectionStart);
    el.value = `${el.value.slice(0, at)}@${fullName} ${after}`;
    const caret = at + fullName.length + 2;
    el.setSelectionRange(caret, caret);
    setQuery(null);
    el.focus();
  }

  /** Grows with the text, up to the cap the stylesheet sets. */
  function fit(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  return (
    <form ref={formRef} action={formAction}>
      <ErrorBanner message={state.error} />
      <NoticeBanner message={state.notice} />

      {fileName && (
        <div className="mb-1.5 flex items-center gap-2">
          <span className={`chip ${tooBig ? 'tone-danger' : 'tone-accent'}`}>
            {fileName}
            {tooBig ? ` — over ${formatBytes(MAX_UPLOAD_BYTES)}` : ''}
          </span>
          <button
            type="button"
            className="hint cursor-pointer underline underline-offset-4"
            onClick={() => {
              if (fileRef.current) fileRef.current.value = '';
              setFileName(null);
              setTooBig(false);
            }}
          >
            Remove
          </button>
        </div>
      )}

      <div className="relative">
        {picking && (
          <ul className="absolute bottom-full left-0 z-10 mb-2 w-64 overflow-hidden rounded-xl border border-void/15 bg-surface py-1 shadow-lg">
            {matches.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(p.fullName);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[14px] ${
                    i === highlight ? 'bg-accent text-pure' : 'hover:bg-void/[0.06]'
                  }`}
                >
                  <Avatar name={p.fullName} size={22} />
                  {p.fullName}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="composer">
          <label
            className="composer-icon"
            title={`Attach a file — ${ALLOWED_SUMMARY}`}
            aria-label="Attach a file"
          >
            {/* A paperclip, because that is what everyone reaches for. */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            <input
              ref={fileRef}
              type="file"
              name="file"
              accept={allowedTypesForInput()}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setFileName(f ? f.name : null);
                // The browser check is a courtesy; the server refuses it too,
                // and that is the one that counts.
                setTooBig(Boolean(f && f.size > MAX_UPLOAD_BYTES));
              }}
            />
          </label>

          <textarea
            ref={bodyRef}
            name="body"
            rows={1}
            placeholder="Message the team…"
            onInput={(e) => {
              fit(e.currentTarget);
              setQuery(readQuery(e.currentTarget));
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (picking) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % matches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const picked = matches[highlight];
                  if (picked) choose(picked.fullName);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setQuery(null);
                  return;
                }
              }
              // Enter sends, shift+Enter starts a line. Nothing is ever sent
              // while the picker is open — that Enter belongs to the picker.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
          />

          <Send />
        </div>
      </div>
    </form>
  );
}

/** The round accent button, and the only loud thing on the bar. */
function Send() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="composer-send" disabled={pending} aria-label="Send">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12l16-8-6 8 6 8z" />
      </svg>
    </button>
  );
}

// ---------------------------------------------------------------------------

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
        className="cursor-pointer text-[11.5px] font-medium text-void/45 hover:text-void hover:underline"
        onClick={() => setOpen(true)}
      >
        Edit
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-1 w-[min(60ch,78vw)]">
      <ErrorBanner message={state.error} />
      <input type="hidden" name="messageId" value={messageId} />
      <textarea
        name="body"
        rows={2}
        className="input mt-0 text-[14.5px]"
        defaultValue={body}
        autoFocus
      />
      <div className="mt-1.5 flex items-center justify-end gap-3">
        <button
          type="button"
          className="hint cursor-pointer underline underline-offset-4"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <Submit label="Save" busy="Saving…" />
      </div>
    </form>
  );
}

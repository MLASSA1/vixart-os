'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { PREP_KINDS } from '@/lib/labels';


function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

interface ProjectOption {
  id: string;
  label: string;
}

/** Start something. It begins as a draft, visible only to its author. */
export function NewPrepForm({
  action,
  projects,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  projects: readonly ProjectOption[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  return (
    <form ref={formRef} action={formAction} className="rounded-xl border border-void/15 p-5">
      <ErrorBanner message={state.error} />

      <div className="grid gap-4 sm:grid-cols-12">
        <label className="block sm:col-span-5">
          <span className="label block">What is it</span>
          <input name="title" required className="input" placeholder="Roastery — opening film" />
        </label>

        <label className="block sm:col-span-3">
          <span className="label block">Kind</span>
          <select name="kind" className="input" defaultValue="idea">
            {PREP_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>

        <label className="block sm:col-span-4">
          <span className="label block">Project (optional)</span>
          <select name="projectId" className="input" defaultValue="">
            <option value="">Not tied to one yet</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-4 block">
        <span className="label block">Notes</span>
        <textarea
          name="body"
          rows={4}
          className="input"
          placeholder="References, shot ideas, locations, questions to ask the client…"
        />
      </label>

      <div className="mt-4 flex items-center gap-3">
        <Submit label="Start it" busy="Creating…" />
        <span className="hint">
          It starts as a draft. Nobody else can see it — not even Amin — until you
          mark it ready.
        </span>
      </div>
    </form>
  );
}

/** Edit your own. */
export function EditPrepForm({
  action,
  projects,
  current,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  projects: readonly ProjectOption[];
  current: { title: string; kind: string; body: string; projectId: string };
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  return (
    <form action={formAction}>
      <ErrorBanner message={state.error} />

      <div className="grid gap-4 sm:grid-cols-12">
        <label className="block sm:col-span-5">
          <span className="label block">What is it</span>
          <input name="title" required className="input" defaultValue={current.title} />
        </label>
        <label className="block sm:col-span-3">
          <span className="label block">Kind</span>
          <select name="kind" className="input" defaultValue={current.kind}>
            {PREP_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-4">
          <span className="label block">Project</span>
          <select name="projectId" className="input" defaultValue={current.projectId}>
            <option value="">Not tied to one</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-4 block">
        <span className="label block">Notes</span>
        <textarea name="body" rows={12} className="input" defaultValue={current.body} />
      </label>

      <div className="mt-4">
        <Submit label="Save" busy="Saving…" />
      </div>
    </form>
  );
}

'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner, NoticeBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { useKeepOnError } from '@/lib/use-keep-on-error';
import { shareFileAction } from '../actions';

function Save() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-small" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </button>
  );
}

export interface ClientFile {
  id: string;
  name: string;
  shared: boolean;
}

/**
 * What the client sees of this project in their portal, set from here:
 * the sentence under "What happens next", and which files are delivered.
 *
 * Nothing on this page reaches the client unless it is set in this box. Task
 * titles, comments and unshared files stay with the team.
 */
export function ClientView({
  projectId,
  nextStep,
  files,
  save,
}: {
  projectId: string;
  nextStep: string | null;
  files: ClientFile[];
  save: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(save, EMPTY_STATE);
  const keepState = useKeepOnError(state);

  return (
    <div className="space-y-6">
      <form action={formAction} onSubmit={keepState}>
        <ErrorBanner message={state.error} />
        <NoticeBanner message={state.notice} />
        <label className="block">
          <span className="label block">What happens next — one sentence the client reads</span>
          <div className="mt-1 flex flex-wrap items-start gap-3">
            <input
              name="nextStep"
              defaultValue={nextStep ?? ''}
              maxLength={300}
              className="input min-w-64 flex-1"
              placeholder="First cut ready for your review on Thursday."
            />
            <Save />
          </div>
        </label>
      </form>

      <div>
        <p className="label">Delivered files — shared with the client</p>
        {files.length === 0 ? (
          <p className="hint mt-1">Attach files under Files below, then share the finished ones from here.</p>
        ) : (
          <ul className="mt-1 border-t border-void/10">
            {files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-void/10 py-2">
                <span className="min-w-0 truncate">
                  {f.name}
                  {f.shared && <span className="chip tone-ok ml-2">Client can see it</span>}
                </span>
                <form action={shareFileAction}>
                  <input type="hidden" name="attachmentId" value={f.id} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="shared" value={f.shared ? 'false' : 'true'} />
                  <button type="submit" className={f.shared ? 'btn btn-inverse btn-small' : 'btn btn-small'}>
                    {f.shared ? 'Stop sharing' : 'Share with client'}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

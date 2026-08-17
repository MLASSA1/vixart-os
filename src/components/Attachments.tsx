'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { ALLOWED_SUMMARY, allowedTypesForInput, formatBytes } from '@/lib/uploads';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { deleteAttachmentAction } from '@/lib/attachment-actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-small" disabled={pending}>
      {pending ? 'Uploading…' : 'Attach'}
    </button>
  );
}

export interface AttachmentRow {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  caption: string | null;
  uploaderName: string | null;
  createdAt: string;
}

export function Attachments({
  action,
  items,
  revalidate,
  canDelete = true,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  items: readonly AttachmentRow[];
  revalidate: string;
  canDelete?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData) => {
      const result = await action(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    EMPTY_STATE,
  );

  return (
    <div>
      {items.length > 0 && (
        <ul className="border-t border-void/10">
          {items.map((file) => (
            <li
              key={file.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-void/10 py-2.5"
            >
              <div className="min-w-0">
                <a
                  href={`/api/files/${file.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {file.originalName}
                </a>
                <span className="hint ml-3">{formatBytes(Number(file.sizeBytes))}</span>
                {file.caption && <p className="hint">{file.caption}</p>}
              </div>
              <div className="flex items-baseline gap-4">
                <span className="hint">{file.uploaderName ?? '—'}</span>
                {canDelete && (
                  <form action={deleteAttachmentAction}>
                    <input type="hidden" name="attachmentId" value={file.id} />
                    <input type="hidden" name="revalidate" value={revalidate} />
                    <button
                      type="submit"
                      className="hint cursor-pointer underline underline-offset-4"
                    >
                      Remove
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form ref={formRef} action={formAction} className="mt-3">
        <ErrorBanner message={state.error} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="block" htmlFor="file">
            <span className="label block">File</span>
            <input
              id="file"
              name="file"
              type="file"
              required
              accept={allowedTypesForInput()}
              className="mt-1.5 max-w-full text-[14px] file:mr-3 file:cursor-pointer file:border file:border-void file:bg-pure file:px-3 file:py-1.5 file:text-[13px]"
            />
          </label>
          <label className="block flex-1" htmlFor="caption">
            <span className="label block">Note (optional)</span>
            <input id="caption" name="caption" className="input" />
          </label>
          <Submit />
        </div>
        <p className="hint mt-2">{ALLOWED_SUMMARY}</p>
      </form>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import {
  attachmentShape,
  formatBytes,
  formatDuration,
  needsSafari,
  servedInline,
} from '@/lib/upload-types';

/**
 * A file in the client's conversation.
 *
 * The same decision as the team's chat makes — `attachmentShape` — wearing the
 * company's black instead of the studio's paper. The decision is shared and the
 * appearance is not, deliberately: a second copy of "what counts as a
 * photograph" is how a client ends up downloading a picture the team can see.
 *
 * No player component of its own for audio. The team's voice notes are
 * recorded in the browser and carry a measured length; a file that arrives here
 * is whatever somebody attached, so the browser's own controls are both
 * honest and less to go wrong.
 */
export function PortalAttachment({
  fileId,
  name,
  mime,
  sizeBytes,
  durationMs,
}: {
  fileId: string;
  name: string | null;
  mime: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
}) {
  const src = `/api/files/${fileId}`;
  const label = name ?? 'Attachment';
  const shape = attachmentShape(mime);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);

  if (shape === 'audio' && !failed) {
    return (
      <div className="mt-3">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={src} controls preload="metadata" onError={() => setFailed(true)}
               className="w-full max-w-[320px]" />
        {durationMs !== null && (
          <p className="vix-quiet mt-1">{formatDuration(durationMs)}</p>
        )}
      </div>
    );
  }

  if (shape === 'image' && !failed) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`View ${label}`}
          className="mt-3 block cursor-zoom-in"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={label}
            onError={() => setFailed(true)}
            className="max-h-72 w-auto max-w-full object-contain"
            style={{ borderRadius: 2 }}
          />
        </button>

        {open && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={label} onClick={(e) => e.stopPropagation()}
                 className="max-h-full max-w-full object-contain" />
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center text-[22px] text-white"
              style={{ border: '1px solid #ffffff3d' }}
            >
              ×
            </button>
          </div>
        )}
      </>
    );
  }

  if (shape === 'video' && !failed) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        src={src}
        controls
        preload="metadata"
        playsInline
        onError={() => setFailed(true)}
        className="mt-3 max-h-72 w-full bg-black"
        style={{ borderRadius: 2 }}
      />
    );
  }

  return (
    <div className="mt-3">
      <a
        href={src}
        {...(servedInline(mime)
          ? { target: '_blank', rel: 'noreferrer' }
          : { download: label })}
        className="flex items-center gap-3 px-3 py-2.5"
        style={{ border: '1px solid var(--vix-line)', borderRadius: 2 }}
      >
        <span aria-hidden="true" className="text-[15px] opacity-70">▤</span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold">{label}</span>
          <span className="vix-quiet block text-[11.5px]">
            {sizeBytes === null ? '' : formatBytes(sizeBytes)}
            {servedInline(mime) ? ' — opens in a new tab' : ''}
          </span>
        </span>
      </a>
      {(failed || needsSafari(mime)) && (
        <p className="vix-quiet mt-1.5">
          Your browser cannot display this format. Safari can, or open the file.
        </p>
      )}
    </div>
  );
}

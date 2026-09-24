'use client';

import { useEffect, useState } from 'react';
import {
  attachmentShape,
  formatBytes,
  needsSafari,
  servedInline,
} from '@/lib/upload-types';
import { VoiceNote } from './VoiceNote';

/**
 * What somebody sent, shown in the conversation.
 *
 * The rule here is that a thing you post is a thing the other person SEES. A
 * photograph appears, a video plays where it sits, a voice note has its
 * player. Only what a browser genuinely cannot render — a spreadsheet, a Word
 * document — is a row you click to save, because for those the downloads
 * folder is the right destination and not a consolation prize.
 *
 * This existed before as three branches inside the message loop, and video was
 * not one of them: an .mov fell through to the file row, so sending a clip to
 * the team meant everybody downloaded eleven megabytes to watch it in
 * QuickTime. The bytes were served correctly the whole time. Nobody could see
 * them without leaving.
 *
 * Every element that can fail is given somewhere to fail TO. A browser that
 * cannot decode what an iPhone recorded is not an error to swallow — it is the
 * one moment the reader needs to be told what happened and handed the file.
 */
export function Attachment({
  fileId,
  name,
  mime,
  sizeBytes,
  durationMs,
  mine,
}: {
  fileId: string;
  name: string | null;
  mime: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  mine: boolean;
}) {
  /*
   * Never a static path. The only route to the bytes is the authenticated one,
   * which looks the row up again under the reader's own policies.
   */
  const src = `/api/files/${fileId}`;
  const label = name ?? 'Attachment';

  // Set when the element itself reports it cannot handle these bytes. That is
  // the only reliable signal: a .mov holding H.264 plays everywhere and one
  // holding HEVC plays only in Safari, and nothing in the type tells them
  // apart. So we try, and listen.
  const [failed, setFailed] = useState(false);
  const shape = attachmentShape(mime);

  if (shape === 'audio') {
    return <VoiceNote src={src} durationMs={durationMs} mine={mine} />;
  }

  if (shape === 'image' && !failed) {
    return <ImageBubble src={src} label={label} onFail={() => setFailed(true)} />;
  }

  if (shape === 'video' && !failed) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        src={src}
        controls
        // Metadata only: a channel with six clips in it should cost six
        // headers on opening, not six videos over somebody's phone data.
        preload="metadata"
        // Without this iOS takes the video full-screen the moment it plays,
        // covering the conversation it was posted in.
        playsInline
        onError={() => setFailed(true)}
        className="max-h-80 w-full rounded-[11px] bg-black"
      />
    );
  }

  return (
    <FileRow
      src={src}
      label={label}
      sizeBytes={sizeBytes}
      mine={mine}
      // Said plainly, and only when it applies. "Could not be displayed" with
      // no reason invites the reader to think the file is damaged.
      note={
        failed || needsSafari(mime)
          ? 'This browser cannot show this format. Safari can, or open the file.'
          : null
      }
      // A PDF, a photograph or a text file opens in a tab and is read there.
      // A .docx cannot be, so it is saved — which is what the browser does
      // with it anyway, and pretending otherwise opens an empty tab.
      opens={servedInline(mime)}
    />
  );
}

/** A photograph, at the size it is, enlargeable without leaving the page. */
function ImageBubble({
  src,
  label,
  onFail,
}: {
  src: string;
  label: string;
  onFail: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Escape closes it, and the page behind does not scroll while it is up.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block cursor-zoom-in overflow-hidden rounded-[11px]"
        aria-label={`View ${label}`}
      >
        {/*
          `contain`, not `cover`. Cover fills the box by cutting the picture,
          which on anything portrait meant the top and bottom of what somebody
          photographed were simply not in the conversation.

          eslint-disable-next-line @next/next/no-img-element
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={label}
          onError={onFail}
          className="max-h-80 w-auto max-w-full rounded-[11px] object-contain"
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={label}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-[19px] text-white hover:bg-white/25"
          >
            ×
          </button>
          <a
            href={src}
            download
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-4 py-2 text-[13px] font-semibold text-white hover:bg-white/25"
          >
            Save to my device
          </a>
        </div>
      )}
    </>
  );
}

/** The row for what a browser has no way to show. */
function FileRow({
  src,
  label,
  sizeBytes,
  mine,
  note,
  opens,
}: {
  src: string;
  label: string;
  sizeBytes: number | null;
  mine: boolean;
  note: string | null;
  opens: boolean;
}) {
  return (
    <div>
      <a
        href={src}
        {...(opens
          ? { target: '_blank', rel: 'noreferrer' }
          : { download: label })}
        className={`flex items-center gap-2.5 rounded-[11px] px-2.5 py-2 ${
          mine ? 'bg-void/[0.06] hover:bg-void/[0.1]' : 'bg-void/[0.045] hover:bg-void/[0.08]'
        }`}
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-void/10 text-[15px]"
        >
          ▤
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold">{label}</span>
          <span className="block text-[11.5px] text-void/50">
            {sizeBytes === null ? '' : formatBytes(sizeBytes)}
            {opens ? ' — opens in a new tab' : ''}
          </span>
        </span>
      </a>
      {note && <p className="mt-1 text-[11.5px] text-void/55">{note}</p>}
    </div>
  );
}

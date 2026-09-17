'use client';

import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/upload-types';

/**
 * A voice note, played where it sits.
 *
 * The length comes from the database, not from the audio element. WebM out of
 * MediaRecorder has no duration in its header, so `audio.duration` is Infinity
 * until the whole file has been fetched and scanned — meaning a player that
 * asked the file would show nothing, or a dash, exactly when the reader wants
 * to know whether this is seven seconds or four minutes. The recorder measured
 * it; 0048 keeps it; this states it before a byte of audio is requested.
 *
 * No waveform. A real one means decoding the audio in the browser to draw it,
 * and a decorative one that does not match what you are about to hear is a
 * picture pretending to be information.
 */
export function VoiceNote({
  src,
  durationMs,
  mine,
}: {
  src: string;
  /** From the recording. Null for audio that arrived some other way. */
  durationMs: number | null;
  mine: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [atMs, setAtMs] = useState(0);

  // Built here rather than rendered as a tag: nothing should be fetched until
  // somebody presses play. Eight people opening a channel of voice notes
  // should not pull every one of them over the wire.
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'none';
    audio.src = src;
    audioRef.current = audio;

    const onTime = () => setAtMs(audio.currentTime * 1000);
    const onEnd = () => {
      setPlaying(false);
      setAtMs(0);
      audio.currentTime = 0;
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('play', () => setPlaying(true));

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
      audio.src = '';
      audioRef.current = null;
    };
  }, [src]);

  /** The known length, or the element's once it has one. */
  const total =
    durationMs ??
    (audioRef.current && Number.isFinite(audioRef.current.duration)
      ? audioRef.current.duration * 1000
      : null);

  const progress = total && total > 0 ? Math.min(100, (atMs / total) * 100) : 0;

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }

  /** Seeking needs a length to seek within; without one the bar is a readout. */
  function seek(event: React.MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    if (!audio || !total) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    audio.currentTime = (total * ratio) / 1000;
    setAtMs(total * ratio);
  }

  return (
    <div className="flex w-[15rem] max-w-full items-center gap-2.5 py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play voice note'}
        className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full ${
          mine ? 'bg-accent text-pure' : 'bg-void/[0.08] text-void hover:bg-void/[0.14]'
        }`}
      >
        {playing ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1.3" />
            <rect x="14" y="5" width="4" height="14" rx="1.3" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 4.5l12 7.5-12 7.5z" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          onClick={seek}
          role="presentation"
          className="voice-track"
          title={total ? 'Click to skip' : undefined}
        >
          <span className="voice-fill" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-1 text-[11.5px] tabular-nums text-void/50">
          {playing || atMs > 0
            ? `${formatDuration(atMs)}${total ? ` / ${formatDuration(total)}` : ''}`
            : total
              ? formatDuration(total)
              : 'Voice note'}
        </p>
      </div>
    </div>
  );
}

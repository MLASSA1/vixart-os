'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_RECORDING_MS, extensionFor, normaliseMime } from '@/lib/upload-types';

/**
 * Holding a microphone open, and handing back a file.
 *
 * Kept out of the composer because the interesting part is not the button, it
 * is the cleanup: a MediaStream that is not stopped leaves the browser's
 * recording indicator lit and the microphone live after the component has gone.
 * Every exit from here — stop, cancel, error, unmount — goes through `release`.
 *
 * The duration is measured by the clock rather than read back from the file.
 * MediaRecorder writes WebM without a duration in its header, so the file
 * cannot answer the question; the recorder can, and it is the only thing that
 * can say how long a note is before the whole of it has been downloaded.
 */

/** In preference order. Chrome and Firefox take the first, Safari the third. */
const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export interface Recording {
  file: File;
  durationMs: number;
}

export function useRecorder(onDone: (recording: Recording) => void) {
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const keepRef = useRef(true);

  /**
   * Whether recording is possible at all, decided after mount.
   *
   * `navigator.mediaDevices` is absent on an insecure origin — every browser
   * withholds the microphone from plain http except on localhost. That makes
   * this false over a bare LAN address and true in production, which is https.
   * Checked rather than assumed, so the button can say why instead of failing
   * when pressed.
   */
  useEffect(() => {
    setSupported(
      typeof navigator !== 'undefined' &&
        Boolean(navigator.mediaDevices?.getUserMedia) &&
        pickType() !== null,
    );
  }, []);

  const release = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
  }, []);

  // A component that goes away mid-recording must not leave the microphone on.
  useEffect(() => release, [release]);

  const start = useCallback(async () => {
    setProblem(null);
    const type = pickType();
    if (!type) {
      setProblem('This browser cannot record audio.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied, dismissed, or no microphone. All the same to the sender.
      setProblem('No microphone. Check the browser has permission.');
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType: type });
    chunksRef.current = [];
    keepRef.current = true;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      const durationMs = Date.now() - startedAtRef.current;
      const keep = keepRef.current;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      release();

      if (!keep) return;
      const blob = new Blob(chunks, { type });
      // Under a second is a slip of the finger, not a message.
      if (blob.size === 0 || durationMs < 1000) {
        setProblem('Too short. Hold it a moment longer.');
        return;
      }
      const extension = extensionFor(type) ?? 'webm';
      onDone({
        file: new File([blob], `voice-message.${extension}`, { type: normaliseMime(type) }),
        durationMs,
      });
    };

    streamRef.current = stream;
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setRecording(true);
    recorder.start();

    tickRef.current = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsedMs(ms);
      // Stops itself rather than letting somebody send a 40 MB monologue.
      if (ms >= MAX_RECORDING_MS) recorderRef.current?.stop();
    }, 100);
  }, [onDone, release]);

  const stop = useCallback(() => {
    keepRef.current = true;
    recorderRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    keepRef.current = false;
    if (recorderRef.current) recorderRef.current.stop();
    else release();
  }, [release]);

  return { supported, recording, elapsedMs, problem, start, stop, cancel, setProblem };
}

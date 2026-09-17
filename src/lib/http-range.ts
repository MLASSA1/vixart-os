/**
 * Parsing a Range header.
 *
 * A media element cannot skip through a file the server will only hand over
 * from the beginning: pressing play works, dragging the progress bar does
 * nothing at all, silently. That is what a voice note's scrubber needs, and
 * what video has quietly lacked here since attachments existed.
 *
 * Only the single-range form is answered. Multi-range (`bytes=0-9,20-29`)
 * requires a multipart/byteranges body, no browser asks for it when playing
 * media, and half-implementing it would be worse than declining it — a request
 * for more than one range is served the whole file instead, which is always a
 * correct answer to a Range header.
 */

export interface ByteRange {
  start: number;
  /** Inclusive, as the header is. */
  end: number;
}

export type RangeResult =
  | { kind: 'whole' }
  | { kind: 'range'; range: ByteRange }
  /** Syntactically fine, but outside the file: answered with 416. */
  | { kind: 'unsatisfiable' };

export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: 'whole' };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: 'whole' };

  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'whole' };

  // An empty file can satisfy no range at all.
  if (size <= 0) return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;

  if (rawStart === '') {
    // `bytes=-500` — the last 500 bytes, which is how players read a trailer.
    const wanted = Number(rawEnd);
    if (!Number.isFinite(wanted) || wanted <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - wanted);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: 'whole' };
    // A range may ask beyond the end; it is clamped, not refused.
    end = Math.min(end, size - 1);
    if (start >= size || start > end) return { kind: 'unsatisfiable' };
  }

  return { kind: 'range', range: { start, end } };
}

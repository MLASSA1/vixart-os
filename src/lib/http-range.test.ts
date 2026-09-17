import { describe, expect, it } from 'vitest';
import { parseRange } from './http-range';

describe('parseRange', () => {
  const SIZE = 1000;

  it('serves the whole file when nothing is asked', () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: 'whole' });
    expect(parseRange('', SIZE)).toEqual({ kind: 'whole' });
  });

  it('reads an ordinary range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ kind: 'range', range: { start: 0, end: 499 } });
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ kind: 'range', range: { start: 500, end: 999 } });
  });

  it('reads an open-ended range, which is what a player sends to skip', () => {
    expect(parseRange('bytes=300-', SIZE)).toEqual({ kind: 'range', range: { start: 300, end: 999 } });
  });

  it('reads a suffix range', () => {
    expect(parseRange('bytes=-200', SIZE)).toEqual({ kind: 'range', range: { start: 800, end: 999 } });
    // Longer than the file: the whole file, not an error.
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ kind: 'range', range: { start: 0, end: 999 } });
  });

  it('clamps an end past the last byte rather than refusing', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({ kind: 'range', range: { start: 900, end: 999 } });
  });

  it('refuses a start past the end', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=2000-3000', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuses a backwards range', () => {
    expect(parseRange('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('falls back to the whole file for anything it does not answer', () => {
    // Multi-range needs a multipart body; no media player asks for it, and the
    // whole file is always a correct answer to a Range header.
    expect(parseRange('bytes=0-9,20-29', SIZE)).toEqual({ kind: 'whole' });
    expect(parseRange('items=0-9', SIZE)).toEqual({ kind: 'whole' });
    expect(parseRange('bytes=abc-def', SIZE)).toEqual({ kind: 'whole' });
  });

  it('satisfies nothing from an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The composer's file input must never be inside a branch.
 *
 * THIS IS NOT A BROKEN TEST. DO NOT DELETE IT.
 *
 * Voice notes shipped unable to send a single one. The input was rendered
 * inside the not-recording half of a ternary, so while the microphone was open
 * it did not exist. MediaRecorder's `stop` handler sets recording to false and
 * hands over the finished file in the SAME TICK — before React re-renders — so
 * the ref was still null, the file was dropped, and nothing anywhere said so.
 * It type-checked, it built, the tests passed, and the feature was impossible
 * to use.
 *
 * The rule: anything a callback writes into must be mounted for the whole life
 * of the component, not for the half of it that happens to be on screen. The
 * input is therefore rendered unconditionally, above every branch.
 *
 * If this fails, the fix is to move the `<input type="file">` back out of
 * whatever branch it has been put inside — not to relax the check.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/(app)/chat/ChatForms.tsx'),
  'utf8',
);

describe('composer file input', () => {
  it('exists exactly once', () => {
    const inputs = [...SOURCE.matchAll(/<input\s+[^>]*type="file"/g)];
    expect(inputs).toHaveLength(1);
  });

  it('is rendered before any branch that could unmount it', () => {
    const input = SOURCE.indexOf('type="file"');
    // The composer's states: a pending clip, a live recording, or neither.
    const firstBranch = SOURCE.indexOf('{pending ? (');
    expect(input).toBeGreaterThan(-1);
    expect(firstBranch).toBeGreaterThan(-1);
    expect(
      input,
      'the file input is inside a conditional branch again — a recording that ' +
        'finishes while it is unmounted is silently dropped',
    ).toBeLessThan(firstBranch);
  });

  it('is written to from an effect, not from the recorder callback', () => {
    // A callback fires whenever the browser decides; an effect fires after
    // React has rendered. Only the second can rely on the DOM existing.
    expect(SOURCE).toContain('useEffect(() => {');
    expect(SOURCE).toMatch(/const acceptRecording[\s\S]{0,400}setPending\(/);
    expect(
      /const acceptRecording[\s\S]{0,400}fileRef\.current/.test(SOURCE),
      'acceptRecording touches the DOM again; it should only set state',
    ).toBe(false);
  });
});

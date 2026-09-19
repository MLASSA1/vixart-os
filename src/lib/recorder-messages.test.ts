import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 9E — the microphone says what is wrong.
 *
 * Measured first, then fixed. On http://192.168.100.24:4000 the browser
 * reports isSecureContext false and removes navigator.mediaDevices, while
 * leaving MediaRecorder in place; on http://localhost:4000 both are present.
 * That asymmetry is the whole bug: a check on MediaRecorder alone concludes
 * recording works, and then nothing happens when the button is pressed.
 *
 * The messages themselves are the deliverable here — a wrong-but-confident
 * sentence ("No microphone") sends somebody hunting for hardware when the real
 * fix is a padlock in the address bar. They are asserted rather than eyeballed
 * because they are the only part a person ever sees.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/(app)/chat/useRecorder.ts'),
  'utf8',
);

/** The module is a client component; its pure half is read as source. */
function explain(block: string): string {
  const body = SOURCE.slice(SOURCE.indexOf('export function explainBlock'));
  const arm = body.indexOf(`case '${block}':`);
  if (arm === -1) throw new Error(`no arm for ${block}`);
  const text = body.slice(arm, body.indexOf('case ', arm + 10));
  return text.replace(/\s+/g, ' ');
}

describe('what the recorder says when it cannot record', () => {
  it('names the real cause for a plain-http address, not "no microphone"', () => {
    const m = explain('insecure-context');
    expect(m).toMatch(/secure connection/i);
    expect(m).toMatch(/https:\/\/visionxart\.cloud/);
    expect(m).toMatch(/localhost/);
    // The old single message blamed hardware for a transport problem.
    expect(m).not.toMatch(/no microphone/i);
  });

  it('tells a blocked user how to unblock, not that hardware is missing', () => {
    const m = explain('denied');
    expect(m).toMatch(/padlock|address bar/i);
    expect(m).toMatch(/reload/i);
  });

  it('distinguishes absent hardware from a refused permission', () => {
    expect(explain('no-microphone')).toMatch(/no microphone found/i);
    expect(explain('no-microphone')).not.toMatch(/padlock/i);
  });

  it('distinguishes a microphone another app is holding', () => {
    expect(explain('in-use')).toMatch(/another application/i);
  });

  it('checks the secure context BEFORE the codec', () => {
    // Order matters: an insecure origin removes mediaDevices, so testing the
    // codec first reports "this browser cannot record" for a problem that is
    // really "not from this address".
    const effect = SOURCE.slice(SOURCE.indexOf('useEffect(() => {'));
    expect(effect.indexOf('isSecureContext')).toBeLessThan(effect.indexOf('pickType()'));
  });

  it('does not rely on MediaRecorder alone, which exists on insecure origins', () => {
    // Confirmed in a browser: on http://192.168.100.24:4000 MediaRecorder is a
    // function while navigator.mediaDevices is undefined.
    const effect = SOURCE.slice(
      SOURCE.indexOf('useEffect(() => {'),
      SOURCE.indexOf('const release'),
    );
    expect(effect).toContain('navigator.mediaDevices');
  });
});

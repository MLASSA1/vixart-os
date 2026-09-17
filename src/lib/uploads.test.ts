import { describe, expect, it } from 'vitest';
import { resolveInsideRoot } from './uploads';
import {
  allowedTypesForInput,
  extensionFor,
  formatBytes,
  formatDuration,
  isAllowedType,
  isAudio,
  normaliseMime,
} from './upload-types';

describe('upload type allowlist', () => {
  it('accepts the formats an agency actually sends', () => {
    for (const t of ['application/pdf', 'image/png', 'image/jpeg', 'video/mp4']) {
      expect(isAllowedType(t)).toBe(true);
    }
  });

  it('refuses SVG and HTML', () => {
    // Both execute script when served back from our own origin, against a
    // signed-in session. Excluded on purpose, not by oversight.
    expect(isAllowedType('image/svg+xml')).toBe(false);
    expect(isAllowedType('text/html')).toBe(false);
  });

  it('refuses archives and executables', () => {
    for (const t of ['application/zip', 'application/x-msdownload', 'application/x-sh']) {
      expect(isAllowedType(t)).toBe(false);
    }
  });

  it('refuses an unknown type rather than defaulting to allowed', () => {
    expect(isAllowedType('application/octet-stream')).toBe(false);
    expect(isAllowedType('')).toBe(false);
  });

  it('offers the allowlist to the file input', () => {
    expect(allowedTypesForInput()).toContain('application/pdf');
    expect(allowedTypesForInput()).not.toContain('svg');
  });
});

describe('resolveInsideRoot', () => {
  it('resolves a normal generated path', () => {
    const p = resolveInsideRoot('2026/08/0f7d4e2a-1111-2222-3333-444455556666.pdf');
    expect(p).toContain('2026/08/');
  });

  it('refuses traversal out of the uploads root', () => {
    expect(() => resolveInsideRoot('../../etc/passwd')).toThrow(/outside the uploads/i);
    expect(() => resolveInsideRoot('2026/../../../etc/passwd')).toThrow(/outside/i);
  });

  it('refuses an absolute path', () => {
    expect(() => resolveInsideRoot('/etc/passwd')).toThrow(/outside/i);
  });
});

describe('formatBytes', () => {
  it('reads like the rest of the interface', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 kB');
    expect(formatBytes(1_500_000)).toBe('1,4 MB');
  });
});

// ---------------------------------------------------------------------------
// Voice notes
// ---------------------------------------------------------------------------

describe('recorded audio', () => {
  it('accepts what a browser actually records', () => {
    // Chrome and Firefox, then Safari. If any of these is refused the
    // microphone button is decorative on somebody's machine.
    expect(isAllowedType('audio/webm;codecs=opus')).toBe(true);
    expect(isAllowedType('audio/webm')).toBe(true);
    expect(isAllowedType('audio/mp4')).toBe(true);
    expect(isAllowedType('audio/ogg;codecs=opus')).toBe(true);
  });

  it('stores the container, not the codec', () => {
    // The parameter is correct media-type syntax and matches nothing in the
    // table. Normalising is what makes the whitelist a whitelist of containers.
    expect(normaliseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normaliseMime('AUDIO/WEBM; codecs="opus"')).toBe('audio/webm');
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
  });

  it('still refuses what it refused before', () => {
    // A parameter must not become a way past the list.
    expect(isAllowedType('image/svg+xml;charset=utf-8')).toBe(false);
    expect(isAllowedType('text/html;charset=utf-8')).toBe(false);
    expect(isAllowedType('application/zip')).toBe(false);
  });

  it('knows what should be played rather than downloaded', () => {
    expect(isAudio('audio/webm;codecs=opus')).toBe(true);
    expect(isAudio('audio/mpeg')).toBe(true);
    expect(isAudio('video/mp4')).toBe(false);
    expect(isAudio('application/pdf')).toBe(false);
    expect(isAudio(null)).toBe(false);
  });

  it('states a length the way a voice note does', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_000)).toBe('0:07');
    expect(formatDuration(62_000)).toBe('1:02');
    expect(formatDuration(725_000)).toBe('12:05');
    // Rounded to the nearest second, not truncated: a 6.6s note is not 0:06.
    expect(formatDuration(6_600)).toBe('0:07');
  });
});

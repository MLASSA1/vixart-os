import { describe, expect, it } from 'vitest';
import { resolveInsideRoot } from './uploads';
import {
  allowedTypesForInput,
  extensionFor,
  formatBytes,
  formatDuration,
  isAllowedType,
  isAudio,
  isImage,
  isVideo,
  needsSafari,
  normaliseMime,
  servedInline,
  ALLOWED_TYPES,
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

  /**
   * The disposition rule, which decides whether a thing you post is SEEN.
   *
   * `inline` is what makes a photograph appear in the conversation instead of
   * landing in the downloads folder. It is also the header that would let a
   * stored file run as a document on our own origin, so the list is narrow on
   * purpose and these tests exist to keep it that way — particularly the last
   * one, which fails if a future edit widens the list past what may even be
   * stored.
   */
  describe('shown inline, or saved', () => {
    it('shows what a conversation is made of', () => {
      for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
                       'video/mp4', 'video/quicktime', 'application/pdf',
                       'audio/webm', 'text/plain']) {
        expect(servedInline(t), t).toBe(true);
      }
      // Parameters are not the container's business here either.
      expect(servedInline('audio/webm;codecs=opus')).toBe(true);
    });

    it('saves what no browser can render', () => {
      for (const t of [
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
      ]) {
        expect(servedInline(t), t).toBe(false);
      }
      expect(servedInline(null)).toBe(false);
      expect(servedInline('')).toBe(false);
    });

    it('never serves script-bearing formats inline', () => {
      // Neither can be uploaded either. Two doors, because one of them is the
      // difference between a file store and script running against a session.
      for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml',
                       'application/javascript']) {
        expect(servedInline(t), t).toBe(false);
        expect(isAllowedType(t), t).toBe(false);
      }
    });

    it('cannot be widened past what may be stored', () => {
      // A type served inline that cannot be uploaded is a list that has
      // drifted from the one it is supposed to shadow.
      for (const t of Object.keys(ALLOWED_TYPES)) {
        if (servedInline(t)) expect(isAllowedType(t), t).toBe(true);
      }
      for (const t of ['image/jpeg', 'video/quicktime', 'application/pdf']) {
        expect(isAllowedType(t), t).toBe(true);
      }
    });

    it('sorts the media a chat bubble has to choose between', () => {
      expect(isImage('image/png')).toBe(true);
      expect(isImage('video/mp4')).toBe(false);
      expect(isVideo('video/quicktime')).toBe(true);
      expect(isVideo('audio/webm')).toBe(false);
      expect(isImage(null)).toBe(false);
      expect(isVideo(null)).toBe(false);
    });

    it('knows the one still image other browsers cannot decode', () => {
      // An iPhone on "High Efficiency" produces these, and only Safari shows
      // them. Rendering one anyway gives a broken image icon, which reads as
      // the application having lost the photograph.
      expect(needsSafari('image/heic')).toBe(true);
      expect(needsSafari('image/jpeg')).toBe(false);
      // .mov is judged by whether it actually failed to play, not by type: the
      // same container holds H.264, which plays everywhere.
      expect(needsSafari('video/quicktime')).toBe(false);
    });
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

import { describe, expect, it } from 'vitest';
import { allowedTypesForInput, formatBytes, isAllowedType, resolveInsideRoot } from './uploads';

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

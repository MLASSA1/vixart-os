import { describe, expect, it } from 'vitest';
import { labelledRc } from './labels';

/**
 * The label appears once, whichever way the number was typed.
 *
 * The first invoice to carry a client's trade register printed
 * "RC RC 12345 (Agadir)", because the stored value already began with RC —
 * which is how VIXART's own record is written, so it is the likely shape.
 */
describe('labelledRc', () => {
  it('adds the label to a bare number', () => {
    expect(labelledRc('12345')).toBe('RC 12345');
  });

  it('does not double a label the value already carries', () => {
    expect(labelledRc('RC 12345')).toBe('RC 12345');
    expect(labelledRc('RC 12345 (Agadir)')).toBe('RC 12345 (Agadir)');
    expect(labelledRc('RC 69627 (Tribunal de Commerce d’Agadir)'))
      .toBe('RC 69627 (Tribunal de Commerce d’Agadir)');
  });

  it('ignores case and leading space, which is how people type', () => {
    expect(labelledRc('rc 12345')).toBe('rc 12345');
    expect(labelledRc('  RC 12345')).toBe('RC 12345');
    expect(labelledRc('  12345  ')).toBe('RC 12345');
  });

  it('does not treat a number that merely starts with the letters as labelled', () => {
    // "RCS" is the French register, not ours, and must keep its own prefix
    // rather than being read as our label — \b stops at the S.
    expect(labelledRc('RCS Paris 123')).toBe('RC RCS Paris 123');
  });
});

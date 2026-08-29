import { describe, expect, it } from 'vitest';
import { amountInWords, numberInWords } from './amount-in-words';
import { toCentimes } from './money';

/**
 * These go on paper that a client and an accountant both read, so the spelling
 * is not a detail. The cases below are the ones French gets wrong if you build
 * it from a naive tens-and-units table.
 */

describe('numberInWords', () => {
  it('handles the small irregulars', () => {
    expect(numberInWords(0n)).toBe('zéro');
    expect(numberInWords(11n)).toBe('onze');
    expect(numberInWords(16n)).toBe('seize');
    expect(numberInWords(17n)).toBe('dix-sept');
  });

  it('keeps the traditional "et" at 21, 31 and 61', () => {
    expect(numberInWords(21n)).toBe('vingt et un');
    expect(numberInWords(31n)).toBe('trente et un');
    expect(numberInWords(61n)).toBe('soixante et un');
    expect(numberInWords(22n)).toBe('vingt-deux');
  });

  it('builds 70 to 79 on soixante', () => {
    expect(numberInWords(70n)).toBe('soixante-dix');
    expect(numberInWords(71n)).toBe('soixante et onze');
    expect(numberInWords(72n)).toBe('soixante-douze');
    expect(numberInWords(79n)).toBe('soixante-dix-neuf');
  });

  it('pluralises quatre-vingts only when nothing follows', () => {
    expect(numberInWords(80n)).toBe('quatre-vingts');
    expect(numberInWords(81n)).toBe('quatre-vingt-un'); // no "et"
    expect(numberInWords(90n)).toBe('quatre-vingt-dix');
    expect(numberInWords(91n)).toBe('quatre-vingt-onze');
    expect(numberInWords(99n)).toBe('quatre-vingt-dix-neuf');
  });

  it('pluralises cent only as a bare multiple', () => {
    expect(numberInWords(100n)).toBe('cent');
    expect(numberInWords(200n)).toBe('deux cents');
    expect(numberInWords(201n)).toBe('deux cent un');
    expect(numberInWords(180n)).toBe('cent quatre-vingts');
  });

  it('never writes "un mille", and never pluralises mille', () => {
    expect(numberInWords(1000n)).toBe('mille');
    expect(numberInWords(2000n)).toBe('deux mille');
    expect(numberInWords(1500n)).toBe('mille cinq cents');
    expect(numberInWords(80_000n)).toBe('quatre-vingt mille');
  });

  it('pluralises million and milliard, which are nouns', () => {
    expect(numberInWords(1_000_000n)).toBe('un million');
    expect(numberInWords(2_000_000n)).toBe('deux millions');
    expect(numberInWords(1_000_000_000n)).toBe('un milliard');
    expect(numberInWords(2_500_000n)).toBe('deux millions cinq cent mille');
  });
});

describe('amountInWords', () => {
  it('writes a plain total the way an invoice does', () => {
    expect(amountInWords(toCentimes('12500'))).toBe('Douze mille cinq cents dirhams');
  });

  it('adds centimes only when there are some', () => {
    expect(amountInWords(toCentimes('12500,50'))).toBe(
      'Douze mille cinq cents dirhams et cinquante centimes',
    );
    expect(amountInWords(toCentimes('12500,00'))).not.toContain('centime');
  });

  it('gets the singulars right', () => {
    expect(amountInWords(toCentimes('1'))).toBe('Un dirham');
    expect(amountInWords(toCentimes('0,01'))).toBe('Zéro dirham et un centime');
  });

  it('handles zero, which a credit note can legitimately reach', () => {
    expect(amountInWords(0n)).toBe('Zéro dirham');
  });

  it('reads back a realistic invoice total', () => {
    // 48 000,00 HT + 20% TVA = 57 600,00 TTC
    expect(amountInWords(toCentimes('57600'))).toBe(
      'Cinquante-sept mille six cents dirhams',
    );
  });

  it('is never empty, for any amount up to a billion dirhams', () => {
    for (const dh of [0, 1, 7, 19, 20, 71, 80, 99, 100, 101, 1000, 1001, 999_999, 1_000_000]) {
      const words = amountInWords(BigInt(dh) * 100n);
      expect(words.length).toBeGreaterThan(0);
      expect(words).not.toContain('undefined');
      expect(words).not.toContain('NaN');
    }
  });
});

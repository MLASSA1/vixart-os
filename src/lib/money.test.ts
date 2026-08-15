import { describe, expect, it } from 'vitest';
import {
  applyRate,
  divRound,
  formatAmount,
  formatMAD,
  formatRate,
  fromCentimes,
  fromMillis,
  lineTotal,
  sum,
  toCentimes,
  toMillis,
} from './money';
import { computeTotals, rateInForce } from './fiscal';

const NBSP = '\u00A0';

describe('toCentimes', () => {
  it('reads the decimal comma', () => {
    expect(toCentimes('1234,56')).toBe(123456n);
  });

  it('reads the decimal point', () => {
    expect(toCentimes('1234.56')).toBe(123456n);
  });

  it('ignores thousands separators and the currency symbol', () => {
    expect(toCentimes('1 234,56 DH')).toBe(123456n);
    expect(toCentimes(`12${NBSP}345,00`)).toBe(1234500n);
  });

  it('handles negatives', () => {
    expect(toCentimes('-19,99')).toBe(-1999n);
  });

  it('rounds the third decimal to the centime without touching a float', () => {
    expect(toCentimes('0,005')).toBe(1n); // commercial rounding: away from zero
    expect(toCentimes('0,004')).toBe(0n);
    expect(toCentimes('-0,005')).toBe(-1n);
  });

  it('avoids the float trap on 19.99', () => {
    // 19.99 * 100 === 1998.9999999999998 in IEEE-754.
    expect(toCentimes('19,99')).toBe(1999n);
    expect(toCentimes('0,29')).toBe(29n);
    expect(toCentimes('1,005')).toBe(101n);
  });

  it('accepts an integer literal but rejects a float', () => {
    expect(toCentimes(1500)).toBe(150000n);
    expect(() => toCentimes(19.99)).toThrow(/float/);
  });

  it('rejects unreadable input', () => {
    expect(() => toCentimes('')).toThrow();
    expect(() => toCentimes('abc')).toThrow();
    expect(() => toCentimes('12,34,56')).toThrow();
  });
});

describe('fromCentimes', () => {
  it('produces a machine decimal', () => {
    expect(fromCentimes(123456n)).toBe('1234.56');
    expect(fromCentimes(5n)).toBe('0.05');
    expect(fromCentimes(0n)).toBe('0.00');
    expect(fromCentimes(-1999n)).toBe('-19.99');
  });

  it('round-trips exactly', () => {
    for (const v of ['0,01', '19,99', '1 234,56', '999 999,99', '-42,00']) {
      expect(fromCentimes(toCentimes(v))).toBe(
        v.replace(/[\s ]/g, '').replace(',', '.'),
      );
    }
  });
});

describe('formatMAD', () => {
  it('applies the Moroccan format', () => {
    expect(formatMAD(123456n)).toBe(`1${NBSP}234,56${NBSP}DH`);
    expect(formatMAD(0n)).toBe(`0,00${NBSP}DH`);
    expect(formatMAD(5n)).toBe(`0,05${NBSP}DH`);
  });

  it('groups thousands beyond a million', () => {
    expect(formatAmount(123456789n)).toBe(`1${NBSP}234${NBSP}567,89`);
  });

  it('marks a negative with the sign alone, no colour and no parentheses', () => {
    expect(formatAmount(-123456n)).toBe(`−1${NBSP}234,56`);
  });
});

describe('formatRate', () => {
  it('formats basis points', () => {
    expect(formatRate(2000)).toBe(`20${NBSP}%`);
    expect(formatRate(0)).toBe(`0${NBSP}%`);
    expect(formatRate(750)).toBe(`7,5${NBSP}%`);
    expect(formatRate(725)).toBe(`7,25${NBSP}%`);
  });
});

describe('quantities', () => {
  it('converts to thousandths', () => {
    expect(toMillis('1,5')).toBe(1500n);
    expect(toMillis('2')).toBe(2000n);
    expect(toMillis(3)).toBe(3000n);
    expect(toMillis('0,333')).toBe(333n);
  });

  it('renders back without trailing zeros', () => {
    expect(fromMillis(1500n)).toBe('1,5');
    expect(fromMillis(2000n)).toBe('2');
    expect(fromMillis(333n)).toBe('0,333');
  });
});

describe('arithmetic', () => {
  it('rounds division to nearest, 0.5 away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(1n, 3n)).toBe(0n);
    expect(divRound(2n, 3n)).toBe(1n);
  });

  it('computes a line total with a fractional quantity', () => {
    // 1 500,00 DH per day × 1.5 day = 2 250,00 DH
    expect(lineTotal(150000n, 1500n)).toBe(225000n);
    // 333,33 DH × 3 = 999,99 DH — no centime created or lost
    expect(lineTotal(33333n, 3000n)).toBe(99999n);
  });

  it('applies a basis-point rate', () => {
    expect(applyRate(100000n, 2000)).toBe(20000n); // 20% of 1 000,00
    expect(applyRate(99999n, 2000)).toBe(20000n); // rounded to the centime
    expect(applyRate(100000n, 0)).toBe(0n);
  });

  it('sums without drift', () => {
    const lines = Array.from({ length: 1000 }, () => toCentimes('0,10'));
    expect(sum(lines)).toBe(10000n); // exactly 100,00 DH
  });
});

describe('computeTotals', () => {
  const lines = [
    { unitPrice: toCentimes('12 000,00'), quantity: toMillis('1') },
    { unitPrice: toCentimes('2 500,00'), quantity: toMillis('3') },
  ];

  it('computes excl. VAT / VAT / incl. VAT', () => {
    const t = computeTotals({
      lines,
      vatRateBp: 2000,
      withholding: false,
      withholdingRateBp: 0,
    });
    expect(t.totalExclVat).toBe(toCentimes('19 500,00'));
    expect(t.totalVat).toBe(toCentimes('3 900,00'));
    expect(t.totalInclVat).toBe(toCentimes('23 400,00'));
    expect(t.withheld).toBe(0n);
    expect(t.netToCollect).toBe(t.totalInclVat);
  });

  it('handles 0% VAT (exemption)', () => {
    const t = computeTotals({
      lines,
      vatRateBp: 0,
      withholding: false,
      withholdingRateBp: 0,
    });
    expect(t.totalVat).toBe(0n);
    expect(t.totalInclVat).toBe(t.totalExclVat);
  });

  it('subtracts withholding from the net to collect', () => {
    const t = computeTotals({
      lines,
      vatRateBp: 2000,
      withholding: true,
      withholdingRateBp: 7500, // 75% of VAT, as a calculation example only
    });
    expect(t.withheld).toBe(toCentimes('2 925,00'));
    expect(t.netToCollect).toBe(toCentimes('20 475,00'));
    expect(t.netToCollect).toBe(t.totalInclVat - t.withheld);
  });

  it('ignores withholding when the client does not apply it', () => {
    const t = computeTotals({
      lines,
      vatRateBp: 2000,
      withholding: false,
      withholdingRateBp: 7500,
    });
    expect(t.withheld).toBe(0n);
  });
});

describe('rateInForce', () => {
  const versions = [
    { key: 'tva_standard', rateBp: 2000, effectiveFrom: '2026-01-01', note: null },
    { key: 'tva_standard', rateBp: 1800, effectiveFrom: '2027-01-01', note: null },
    { key: 'retenue_source_tva', rateBp: 0, effectiveFrom: '2026-01-01', note: null },
  ];

  it('picks the version in force on the requested date', () => {
    expect(rateInForce(versions, 'tva_standard', '2026-06-30')?.rateBp).toBe(2000);
    expect(rateInForce(versions, 'tva_standard', '2027-03-01')?.rateBp).toBe(1800);
  });

  it('ignores a version not yet in force', () => {
    expect(rateInForce(versions, 'tva_standard', '2025-12-31')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(rateInForce([], 'tva_standard', '2026-01-01')).toBeNull();
  });
});

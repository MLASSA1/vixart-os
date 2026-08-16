import { describe, expect, it } from 'vitest';
import { computeDealTotals } from './deal-totals';
import { toCentimes, toMillis, formatMAD } from './money';

const line = (price: string, qty: string) => ({
  unitPriceCentimes: toCentimes(price),
  quantityMillis: toMillis(qty),
});

describe('computeDealTotals', () => {
  it('adds the lines and applies VAT', () => {
    const t = computeDealTotals({
      lines: [line('12 000', '1'), line('2 500', '3')],
      discountCentimes: 0n,
      vatRateBp: 2000,
    });
    expect(t.subtotal).toBe(toCentimes('19 500'));
    expect(t.totalExclVat).toBe(toCentimes('19 500'));
    expect(t.totalVat).toBe(toCentimes('3 900'));
    expect(t.totalInclVat).toBe(toCentimes('23 400'));
  });

  it('takes the money discount off the taxable base, not off the total', () => {
    const t = computeDealTotals({
      lines: [line('20 000', '1')],
      discountCentimes: toCentimes('5 000'),
      vatRateBp: 2000,
    });
    expect(t.totalExclVat).toBe(toCentimes('15 000'));
    // VAT on 15 000, not on 20 000 — the discount reduces what is taxed.
    expect(t.totalVat).toBe(toCentimes('3 000'));
    expect(t.totalInclVat).toBe(toCentimes('18 000'));
  });

  it('never lets a discount produce a negative bill', () => {
    const t = computeDealTotals({
      lines: [line('1 000', '1')],
      discountCentimes: toCentimes('9 999'),
      vatRateBp: 2000,
    });
    expect(t.discountApplied).toBe(toCentimes('1 000'));
    expect(t.totalExclVat).toBe(0n);
    expect(t.totalInclVat).toBe(0n);
  });

  it('ignores a negative discount rather than adding to the bill', () => {
    const t = computeDealTotals({
      lines: [line('1 000', '1')],
      discountCentimes: toCentimes('-500'),
      vatRateBp: 2000,
    });
    expect(t.discountApplied).toBe(0n);
    expect(t.totalExclVat).toBe(toCentimes('1 000'));
  });

  it('handles a fractional quantity exactly', () => {
    // 1 500,00 per day over 2,5 days = 3 750,00
    const t = computeDealTotals({
      lines: [line('1 500', '2,5')],
      discountCentimes: 0n,
      vatRateBp: 2000,
    });
    expect(t.subtotal).toBe(toCentimes('3 750'));
  });

  it('creates no centime across many awkward lines', () => {
    const t = computeDealTotals({
      lines: Array.from({ length: 7 }, () => line('333,33', '3')),
      discountCentimes: 0n,
      vatRateBp: 2000,
    });
    // 333,33 x 3 = 999,99 per line, seven lines = 6 999,93
    expect(t.subtotal).toBe(toCentimes('6 999,93'));
    expect(formatMAD(t.subtotal)).toBe('6 999,93 DH');
  });

  it('handles a 0% rate for an exempt document', () => {
    const t = computeDealTotals({
      lines: [line('10 000', '1')],
      discountCentimes: 0n,
      vatRateBp: 0,
    });
    expect(t.totalVat).toBe(0n);
    expect(t.totalInclVat).toBe(toCentimes('10 000'));
  });

  it('is empty, not broken, with no lines', () => {
    const t = computeDealTotals({ lines: [], discountCentimes: 0n, vatRateBp: 2000 });
    expect(t.subtotal).toBe(0n);
    expect(t.totalInclVat).toBe(0n);
    expect(t.lineTotals).toEqual([]);
  });
});

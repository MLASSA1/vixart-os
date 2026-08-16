/**
 * VIXART OS — what a deal is worth.
 *
 * Pure and testable: no database, no React. The page renders what this returns,
 * and the quote/invoice will compute from the same function so the figure a
 * client is shown can never drift from the figure on the deal.
 *
 * Entirely bigint centimes. Nothing here touches a float.
 */

import { computeTotals } from './fiscal';
import { lineTotal, sum, type BasisPoints, type Centimes, type Millis } from './money';

export interface PricedLine {
  unitPriceCentimes: Centimes;
  quantityMillis: Millis;
}

export interface DealTotals {
  /** Sum of the lines, before any discount. */
  subtotal: Centimes;
  /** The discount actually applied — capped so the total never goes negative. */
  discountApplied: Centimes;
  totalExclVat: Centimes;
  totalVat: Centimes;
  totalInclVat: Centimes;
  /** Per-line totals, in the order given, for rendering the table. */
  lineTotals: Centimes[];
}

export function computeDealTotals(input: {
  lines: readonly PricedLine[];
  discountCentimes: Centimes;
  vatRateBp: BasisPoints;
}): DealTotals {
  const lineTotals = input.lines.map((l) =>
    lineTotal(l.unitPriceCentimes, l.quantityMillis),
  );
  const subtotal = sum(lineTotals);

  // A discount larger than the subtotal zeroes the bill; it never turns into a
  // credit. Anything else would be an invoice that owes the client money.
  const requested = input.discountCentimes < 0n ? 0n : input.discountCentimes;
  const discountApplied = requested > subtotal ? subtotal : requested;
  const netExclVat = subtotal - discountApplied;

  // VAT is charged on the discounted amount, not the list price: the discount
  // reduces the taxable base, which is how it prints on a Moroccan invoice.
  const totals = computeTotals({
    lines: [{ unitPrice: netExclVat, quantity: 1000n }],
    vatRateBp: input.vatRateBp,
    withholding: false,
    withholdingRateBp: 0,
  });

  return {
    subtotal,
    discountApplied,
    totalExclVat: totals.totalExclVat,
    totalVat: totals.totalVat,
    totalInclVat: totals.totalInclVat,
    lineTotals,
  };
}

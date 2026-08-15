/**
 * VIXART OS — versioned tax parameters and document totals.
 *
 * PRINCIPLE: no rate is hardcoded in application code. Every rate lives in the
 * `fiscal_rate` table with an `effective_from` date. A rate is never edited —
 * a new version is inserted. An already-issued document keeps the rate copied
 * onto it at issue time; it is NEVER read back from this table for rendering.
 *
 * The constants below are seed values for a blank cluster only, not the source
 * of truth at runtime.
 */

import {
  applyRate,
  lineTotal,
  sum,
  type BasisPoints,
  type Centimes,
  type Millis,
} from './money';

// ---------------------------------------------------------------------------
// Parameter keys
// ---------------------------------------------------------------------------

export const FISCAL_KEYS = {
  /** Standard VAT applicable to advertising services. */
  VAT_STANDARD: 'tva_standard',
  /**
   * Withholding tax on VAT — article 117 bis of the Moroccan CGI.
   * The share of VAT some clients withhold and remit themselves.
   */
  WITHHOLDING_VAT: 'retenue_source_tva',
} as const;

export type FiscalKey = (typeof FISCAL_KEYS)[keyof typeof FISCAL_KEYS];

/**
 * Seed values.
 *
 * Standard VAT: 20% — the ordinary rate on advertising services.
 *
 * Withholding: seeded at 0 DELIBERATELY. The applicable rate depends on the
 * tax situation of both VIXART and the client; it must be entered by the
 * founder on the accountant's advice, not guessed by a developer. While it is
 * 0, "Net to collect" equals "Total incl. VAT".
 */
export const SEED_RATES: ReadonlyArray<{
  key: FiscalKey;
  bp: BasisPoints;
  effectiveFrom: string;
  note: string;
}> = [
  {
    key: FISCAL_KEYS.VAT_STANDARD,
    bp: 2000,
    effectiveFrom: '2026-01-01',
    note: 'Standard VAT — advertising services (agency).',
  },
  {
    key: FISCAL_KEYS.WITHHOLDING_VAT,
    bp: 0,
    effectiveFrom: '2026-01-01',
    note:
      'TO BE SET BY THE FOUNDER (art. 117 bis CGI). Kept at zero until the ' +
      'accountant confirms the applicable rate. Do not guess: add a new dated ' +
      'version rather than editing this one.',
  },
];

// ---------------------------------------------------------------------------
// Picking the version in force
// ---------------------------------------------------------------------------

export interface RateVersion {
  key: string;
  /** Rate in basis points. */
  rateBp: number;
  /** Effective date, ISO `YYYY-MM-DD`. */
  effectiveFrom: string;
  note: string | null;
}

/**
 * Returns the version of a rate in force on a given date: the most recent one
 * whose `effective_from` is on or before that date.
 *
 * Pure function — testable without a database.
 */
export function rateInForce(
  versions: readonly RateVersion[],
  key: FiscalKey,
  date: string,
): RateVersion | null {
  const candidates = versions
    .filter((v) => v.key === key && v.effectiveFrom <= date)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Document totals
// ---------------------------------------------------------------------------

export interface DocumentLine {
  /** Unit price frozen on the document, in centimes. */
  unitPrice: Centimes;
  /** Quantity in thousandths of a unit. */
  quantity: Millis;
}

export interface TotalsInput {
  lines: readonly DocumentLine[];
  /** VAT rate frozen on the document, in basis points (2000 = 20%). */
  vatRateBp: BasisPoints;
  /** Does this client apply withholding tax at source? */
  withholding: boolean;
  /** Withholding rate frozen on the document, in basis points. */
  withholdingRateBp: BasisPoints;
}

export interface Totals {
  /** Total excluding tax. */
  totalExclVat: Centimes;
  /** VAT amount. */
  totalVat: Centimes;
  /** Total including tax. */
  totalInclVat: Centimes;
  /** Share of VAT withheld at source by the client (0 when not applicable). */
  withheld: Centimes;
  /** What VIXART actually collects: total incl. VAT − withheld. */
  netToCollect: Centimes;
}

/**
 * Computes document totals. Entirely in centimes, entirely in bigint.
 *
 * VAT is computed on the rounded excl.-VAT total rather than line by line, so
 * that the addition shown on the document is always exact.
 */
export function computeTotals(input: TotalsInput): Totals {
  const totalExclVat = sum(input.lines.map((l) => lineTotal(l.unitPrice, l.quantity)));
  const totalVat = applyRate(totalExclVat, input.vatRateBp);
  const totalInclVat = totalExclVat + totalVat;

  const withheld =
    input.withholding && input.withholdingRateBp > 0
      ? applyRate(totalVat, input.withholdingRateBp)
      : 0n;

  return {
    totalExclVat,
    totalVat,
    totalInclVat,
    withheld,
    netToCollect: totalInclVat - withheld,
  };
}

/**
 * A 0% VAT rate requires a written justification (exemption, export, …).
 * Also enforced by a CHECK constraint in the database — this is only the UI guard.
 */
export function justificationRequired(vatRateBp: BasisPoints): boolean {
  return vatRateBp === 0;
}

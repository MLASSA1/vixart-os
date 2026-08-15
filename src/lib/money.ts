/**
 * VIXART OS — money arithmetic.
 *
 * HARD RULE: an amount is a `bigint` of centimes. Never a `number`, never a
 * float, never a `string` inside a calculation. JavaScript's `number` is an
 * IEEE-754 float: 0.1 + 0.2 !== 0.3, and an invoice that is wrong by one
 * centime is a wrong invoice.
 *
 * All conversion goes through string manipulation, never float multiplication
 * (`x * 100` is already wrong for x = 19.99).
 *
 * Units:
 *   - amounts     → centimes     (bigint)  1 DH = 100
 *   - quantities  → thousandths  (bigint)  1 unit = 1000 (allows 0.5 day)
 *   - rates       → basis points (number)  20% = 2000
 *
 * Display keeps the Moroccan convention — `1 234,56 DH`, non-breaking space for
 * thousands, comma for decimals — because that is what an invoice issued in
 * Morocco must show. The interface language is English; this format is a legal
 * one, not a linguistic one, so screens and issued documents cannot disagree.
 */

/** An amount in centimes of dirham. */
export type Centimes = bigint;

/** A quantity in thousandths of a unit (1 unit = 1000). */
export type Millis = bigint;

/** A rate in basis points (1% = 100 bp, 20% = 2000 bp). */
export type BasisPoints = number;

export const CENTIMES_PER_DIRHAM = 100n;
export const MILLIS_PER_UNIT = 1000n;
export const BP_PER_UNIT = 10_000n;

/**
 * Non-breaking space U+00A0 — the thousands separator.
 * Written escaped on purpose: a literal non-breaking space is invisible in an
 * editor and silently degrades to a plain space when copy-pasted.
 */
const NBSP = '\u00A0';

/** Whitespace ignored in input: plain, non-breaking, thin, narrow no-break. */
const SPACES = /[\s\u00A0\u202F\u2009]/g;

// ---------------------------------------------------------------------------
// Rounded division
// ---------------------------------------------------------------------------

/**
 * Integer division with commercial rounding (0.5 rounds away from zero).
 * This is the rounding rule used on Moroccan tax documents.
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('money: division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Parses user input into centimes.
 *
 * Accepts: "1234,56"  "1 234,56"  "1234.56"  "1 234,56 DH"  "-19.99"  1500
 * Beyond 2 decimals, commercial rounding applies.
 *
 * A `number` is accepted only when it is an integer (a code literal such as
 * `toCentimes(1500)`); any float is rejected, because it may already be wrong
 * by the time this function receives it.
 */
export function toCentimes(input: string | number): Centimes {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      throw new Error(
        `money: float rejected (${input}). Pass a string instead: toCentimes("${input}")`,
      );
    }
    return BigInt(input) * CENTIMES_PER_DIRHAM;
  }

  let s = input
    .replace(SPACES, '')
    .replace(/DH|MAD|د\.م\./gi, '')
    .trim();

  if (s === '') throw new Error('money: empty amount');

  let sign = 1n;
  if (s.startsWith('-')) {
    sign = -1n;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // Accept both the decimal comma and the decimal point.
  s = s.replace(',', '.');

  if (!/^\d*(\.\d*)?$/.test(s) || s === '.' || s === '') {
    throw new Error(`money: unreadable amount "${input}"`);
  }

  const [wholePart = '0', decimalPart = ''] = s.split('.');

  // Keep 3 decimals so the third can be rounded, without ever touching a float.
  const milliCentimes =
    BigInt(wholePart || '0') * 1000n + BigInt((decimalPart + '000').slice(0, 3));

  return sign * divRound(milliCentimes, 10n);
}

/**
 * Machine-readable decimal: "1234.56". For CSV, APIs and tests.
 * Never for display — use `formatMAD`.
 */
export function fromCentimes(centimes: Centimes): string {
  const negative = centimes < 0n;
  const abs = negative ? -centimes : centimes;
  const dirhams = abs / CENTIMES_PER_DIRHAM;
  const rest = abs % CENTIMES_PER_DIRHAM;
  return `${negative ? '-' : ''}${dirhams}.${rest.toString().padStart(2, '0')}`;
}

/** Converts a typed quantity ("1,5", "2", 3) into thousandths of a unit. */
export function toMillis(input: string | number): Millis {
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new Error(`money: float quantity rejected (${input}), pass a string`);
    }
    return BigInt(input) * MILLIS_PER_UNIT;
  }
  const s = input.replace(SPACES, '').replace(',', '.');
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') {
    throw new Error(`money: unreadable quantity "${input}"`);
  }
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [whole = '0', dec = ''] = body.split('.');
  const tenThousandths =
    BigInt(whole || '0') * 10_000n + BigInt((dec + '0000').slice(0, 4));
  const millis = divRound(tenThousandths, 10n);
  return negative ? -millis : millis;
}

/** Readable quantity: 1500n → "1,5"; 2000n → "2". */
export function fromMillis(millis: Millis): string {
  const negative = millis < 0n;
  const abs = negative ? -millis : millis;
  const whole = abs / MILLIS_PER_UNIT;
  const rest = abs % MILLIS_PER_UNIT;
  const sign = negative ? '-' : '';
  if (rest === 0n) return `${sign}${whole}`;
  return `${sign}${whole},${rest.toString().padStart(3, '0').replace(/0+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Moroccan display format
// ---------------------------------------------------------------------------

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/**
 * VIXART display format: `1 234,56 DH`
 * Non-breaking space for thousands, decimal comma, suffixed symbol.
 */
export function formatMAD(centimes: Centimes): string {
  return `${formatAmount(centimes)}${NBSP}DH`;
}

/** Same without the symbol — for table columns already headed "DH". */
export function formatAmount(centimes: Centimes): string {
  const negative = centimes < 0n;
  const abs = negative ? -centimes : centimes;
  const dirhams = (abs / CENTIMES_PER_DIRHAM).toString();
  const rest = (abs % CENTIMES_PER_DIRHAM).toString().padStart(2, '0');
  // The minus sign is the only marker: no colour, no parentheses.
  return `${negative ? '−' : ''}${groupThousands(dirhams)},${rest}`;
}

/** Basis points → "20 %", "7,5 %", "0 %". */
export function formatRate(bp: BasisPoints): string {
  const whole = Math.trunc(bp / 100);
  const decimals = Math.abs(bp % 100);
  if (decimals === 0) return `${whole}${NBSP}%`;
  const frac = decimals.toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole},${frac}${NBSP}%`;
}

// ---------------------------------------------------------------------------
// Line and document maths
// ---------------------------------------------------------------------------

/** Line total: unit price × quantity, rounded to the centime. */
export function lineTotal(unitPrice: Centimes, quantity: Millis): Centimes {
  return divRound(unitPrice * quantity, MILLIS_PER_UNIT);
}

/** Applies a basis-point rate to a base. 20% of 1000.00 → 200.00. */
export function applyRate(base: Centimes, bp: BasisPoints): Centimes {
  if (!Number.isInteger(bp)) {
    throw new Error(`money: non-integer basis-point rate (${bp})`);
  }
  return divRound(base * BigInt(bp), BP_PER_UNIT);
}

/** Safe sum of a list of amounts. */
export function sum(amounts: readonly Centimes[]): Centimes {
  return amounts.reduce<Centimes>((acc, m) => acc + m, 0n);
}

export const ZERO: Centimes = 0n;

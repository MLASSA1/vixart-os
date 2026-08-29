/**
 * VIXART OS — the amount spelled out in French.
 *
 * Moroccan invoices carry the total written in words as well as figures —
 * "Arrêtée la présente facture à la somme de …". It is what makes the figure
 * hard to alter after the fact: a digit can be changed with a pen, a sentence
 * cannot. Every accountant and every client here expects to see it, and an
 * invoice without it looks improvised.
 *
 * French spelling, not Belgian or Swiss: 70 is soixante-dix, 80 quatre-vingts,
 * 90 quatre-vingt-dix. The traditional "et" is kept at 21, 31, 41, 51, 61 and
 * 71, which is what appears on Moroccan paperwork.
 *
 * Takes centimes, like everything else that touches money here. Never a float.
 */

import type { Centimes } from './money';

const UNDER_20 = [
  'zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit',
  'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
  'dix-sept', 'dix-huit', 'dix-neuf',
] as const;

const TENS: Record<number, string> = {
  20: 'vingt', 30: 'trente', 40: 'quarante', 50: 'cinquante',
};

/**
 * `pluralise` is false when this group is immediately followed by "mille".
 * "vingt" and "cent" take their s as bare multiples — quatre-vingts, deux
 * cents — but lose it before the numeral mille: quatre-vingt mille, deux cent
 * mille. They keep it before million and milliard, which are nouns.
 */
function under100(n: number, pluralise = true): string {
  if (n < 20) return UNDER_20[n] as string;

  // 60–79 and 80–99 are built on one word each, which is why they are not
  // a simple tens + units lookup.
  if (n >= 80) {
    const r = n - 80;
    // "quatre-vingts" takes its s only when nothing follows it at all.
    if (r === 0) return pluralise ? 'quatre-vingts' : 'quatre-vingt';
    return `quatre-vingt-${under100(r)}`;
  }
  if (n >= 60) {
    const r = n - 60;
    if (r === 0) return 'soixante';
    if (r === 1) return 'soixante et un';
    if (r === 11) return 'soixante et onze';
    return `soixante-${under100(r)}`;
  }

  const t = Math.floor(n / 10) * 10;
  const u = n % 10;
  const tens = TENS[t] as string;
  if (u === 0) return tens;
  if (u === 1) return `${tens} et un`;
  return `${tens}-${UNDER_20[u]}`;
}

function under1000(n: number, pluralise = true): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 0) return under100(r, pluralise);

  // "cent" pluralises only as a bare multiple: deux cents, but deux cent un.
  if (r === 0) return h === 1 ? 'cent' : `${UNDER_20[h]} cent${pluralise ? 's' : ''}`;
  return h === 1
    ? `cent ${under100(r, pluralise)}`
    : `${UNDER_20[h]} cent ${under100(r, pluralise)}`;
}

const SCALES: ReadonlyArray<{ value: bigint; name: string }> = [
  { value: 1_000_000_000n, name: 'milliard' },
  { value: 1_000_000n, name: 'million' },
  { value: 1_000n, name: 'mille' },
];

/** A whole number in French words. Works on bigint, so nothing overflows. */
export function numberInWords(value: bigint): string {
  if (value < 0n) return `moins ${numberInWords(-value)}`;
  if (value === 0n) return 'zéro';

  const parts: string[] = [];
  let rest = value;

  for (const { value: scale, name } of SCALES) {
    const q = rest / scale;
    rest %= scale;
    if (q === 0n) continue;

    if (name === 'mille') {
      // "mille" never takes an s, and never "un mille".
      parts.push(q === 1n ? 'mille' : `${under1000(Number(q), false)} mille`);
    } else {
      // million and milliard are nouns: they pluralise, and take "un".
      const head = q === 1n ? 'un' : under1000(Number(q));
      parts.push(`${head} ${name}${q > 1n ? 's' : ''}`);
    }
  }

  if (rest > 0n) parts.push(under1000(Number(rest)));
  return parts.join(' ');
}

/**
 * The full sentence as it appears on the document, e.g.
 * "Douze mille cinq cents dirhams et cinquante centimes".
 *
 * Centimes are dropped when there are none, which is how these are written by
 * hand — "et zéro centime" reads like a machine wrote it.
 */
export function amountInWords(centimes: Centimes): string {
  const negative = centimes < 0n;
  const absolute = negative ? -centimes : centimes;

  const dirhams = absolute / 100n;
  const rest = absolute % 100n;

  // French takes the singular at zero as well as one: zéro dirham, un dirham.
  let text = `${numberInWords(dirhams)} ${dirhams < 2n ? 'dirham' : 'dirhams'}`;
  if (rest > 0n) {
    text += ` et ${numberInWords(rest)} ${rest < 2n ? 'centime' : 'centimes'}`;
  }
  if (negative) text = `moins ${text}`;

  return text.charAt(0).toUpperCase() + text.slice(1);
}

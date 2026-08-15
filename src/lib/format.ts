/**
 * VIXART OS — display formatting. English, Agadir time.
 *
 * Dates always render in Casablanca time regardless of the browser's timezone:
 * two team members travelling must read the same date on the same record.
 *
 * Day-first ordering (en-GB) is kept because that is how dates are written in
 * Morocco; only the language changes, not the convention.
 */

const TIMEZONE = 'Africa/Casablanca';
const LOCALE = 'en-GB';

const shortDate = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const longDate = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const dateTime = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 15/08/2026 */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return shortDate.format(new Date(value));
}

/** 15 August 2026 */
export function formatLongDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return longDate.format(new Date(value));
}

/** 15/08/2026, 14:32 */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return dateTime.format(new Date(value));
}

/** `YYYY-MM-DDTHH:mm` for a datetime-local field, in Casablanca time. */
export function forDateTimeField(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
  return parts.replace(' ', 'T');
}

/** "3 days ago", "today". Used for how fresh a last contact is. */
export function since(value: Date | string | null | undefined): string {
  if (!value) return 'never';
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * Normalises a Moroccan number for a WhatsApp link: 06 12 34 56 78 → 212612345678.
 * Returns null when the number is unusable, rather than a broken link.
 */
export function whatsappLink(number: string | null | undefined): string | null {
  if (!number) return null;
  const digits = number.replace(/[^\d+]/g, '');
  let national = digits.replace(/^\+/, '');

  if (national.startsWith('00')) national = national.slice(2);
  // 0612345678 → 212612345678
  if (national.startsWith('0') && national.length === 10) {
    national = `212${national.slice(1)}`;
  }
  if (national.length < 9 || national.length > 15) return null;
  return `https://wa.me/${national}`;
}

/** Splits text into paragraphs for display, without injecting any HTML. */
export function paragraphs(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

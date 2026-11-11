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

/*
 * THE CLOCK IS THE SERVER'S, not only the zone.
 *
 * Naming the zone is necessary and was not enough. In November 2026 a chat
 * timestamp rendered 12:22 on the server and 11:22 in the browser — both
 * formatting in Africa/Casablanca. Morocco's offset rule changed in the time
 * zone database during 2026: Node with tzdata 2026a put Casablanca at UTC+1
 * that day, Node with 2026e (production) and a current Chrome at UTC+0. React
 * saw two different strings, threw the server's HTML away and showed the
 * BROWSER's answer — which on any phone with stale tz data is an hour wrong.
 *
 * So anything formatted for a client component is formatted on the server and
 * handed over as text, and the browser does no date arithmetic of its own. The
 * server's tz data is current as of its last deploy; a device's is current as
 * of whenever it last updated, which nobody here controls. The helpers below
 * are pure, so they run on the server; `dayHeading` takes day KEYS rather than
 * instants precisely so that it can also run in the browser without ever
 * consulting the device's idea of Morocco.
 */

const clock = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Formats a day KEY, which already is the Casablanca calendar day: read at
// noon UTC so that no zone can move it across midnight.
const dayName = new Intl.DateTimeFormat(LOCALE, {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const dayMonthClock = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "10 Nov, 11:22", Casablanca time. The client portal's message stamp. */
export function formatDayMonthClock(value: Date | string): string {
  return dayMonthClock.format(new Date(value));
}

/** 14:32, Casablanca time. Server side: see the note above. */
export function formatClock(value: Date | string): string {
  return clock.format(new Date(value));
}

/** "2026-11-10": the Casablanca calendar day an instant falls on. */
export function casablancaDay(value: Date | string = new Date()): string {
  return dayKeyFormat.format(new Date(value));
}

/**
 * "Today", "Yesterday", otherwise "Tuesday 10 November", from two day keys.
 *
 * Pure arithmetic on keys, so it gives the same answer on the server and in
 * any browser: `today` comes from the server too, never from `new Date()` in
 * the client.
 */
export function dayHeading(day: string, today: string): string {
  if (day === today) return 'Today';
  const t = new Date(`${today}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  if (day === t.toISOString().slice(0, 10)) return 'Yesterday';
  return dayName.format(new Date(`${day}T12:00:00Z`));
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

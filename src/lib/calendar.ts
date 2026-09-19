/**
 * Dates for the schedule.
 *
 * All of it works on plain YYYY-MM-DD strings rather than Date objects.
 * A schedule entry is a DAY, not an instant: "Thursday" is Thursday in Agadir
 * whatever the browser's clock says, and `new Date('2026-09-19')` parses as
 * midnight UTC, which in a negative offset is the 18th. Keeping everything as
 * strings and doing the arithmetic in UTC removes the whole class of problem.
 *
 * The week starts on MONDAY. Sunday is the day this team actually takes off,
 * so a week that starts on Sunday would put the rest day in the middle of the
 * working span and split every weekend across two rows.
 */

export type Ymd = string;

export function today(): Ymd {
  const now = new Date();
  // Local date, then frozen as a string — the point above, from the other side.
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

function toUtc(d: Ymd): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, day ?? 1));
}

function fromUtc(d: Date): Ymd {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Ymd, n: number): Ymd {
  const x = toUtc(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fromUtc(x);
}

export function addMonths(d: Ymd, n: number): Ymd {
  const x = toUtc(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  // Clamp: 31 January plus one month is 28 or 29 February, not 3 March.
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return fromUtc(x);
}

/** Monday of the week containing `d`. */
export function startOfWeek(d: Ymd): Ymd {
  const x = toUtc(d);
  // getUTCDay: 0 = Sunday. Monday-based offset puts Sunday at the end.
  const offset = (x.getUTCDay() + 6) % 7;
  return addDays(d, -offset);
}

export function startOfMonth(d: Ymd): Ymd {
  return `${d.slice(0, 7)}-01`;
}

export function endOfMonth(d: Ymd): Ymd {
  const x = toUtc(startOfMonth(d));
  x.setUTCMonth(x.getUTCMonth() + 1);
  x.setUTCDate(0);
  return fromUtc(x);
}

/** The days a month view must draw: whole weeks, Monday to Sunday. */
export function monthGrid(d: Ymd): Ymd[] {
  const first = startOfWeek(startOfMonth(d));
  const last = endOfMonth(d);
  const out: Ymd[] = [];
  let cursor = first;
  // Always whole weeks, and always through the end of the month.
  while (cursor <= last || out.length % 7 !== 0) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    if (out.length > 42) break; // six weeks is the most a month can span
  }
  return out;
}

export function weekDays(d: Ymd): Ymd[] {
  const start = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isWeekend(d: Ymd): boolean {
  // Sunday only. Saturday is a working day here.
  return toUtc(d).getUTCDay() === 0;
}

export function dayLabel(d: Ymd): string {
  return toUtc(d).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export function monthLabel(d: Ymd): string {
  return toUtc(d).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function dayNumber(d: Ymd): string {
  return String(toUtc(d).getUTCDate());
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayHeading, formatClock, casablancaDay, formatDayMonthClock } from './format';

/**
 * One clock, the server's.
 *
 * Chat timestamps hydrated as 12:22 on the server and 11:22 in the browser,
 * both nominally in Africa/Casablanca: Morocco's offset rule changed in the
 * time zone database during 2026, and Node with tzdata 2026a and a current
 * Chrome disagreed by an hour. The fix is that the server formats and the
 * browser only displays — so these helpers must give the same answer whatever
 * zone the PROCESS is in, and `dayHeading` must not consult any zone at all.
 *
 * Deliberately NOT asserted: what wall-clock time a given November instant is
 * in Casablanca. That answer is the tz database's, it differs between the
 * machines this suite runs on, and a test that pinned it would be pinning the
 * bug.
 */

const realTZ = process.env.TZ;
afterEach(() => {
  if (realTZ === undefined) delete process.env.TZ;
  else process.env.TZ = realTZ;
});

/**
 * The module, freshly loaded with the PROCESS in another zone.
 *
 * Reloaded rather than reused because the formatters are built once, at load:
 * flipping `process.env.TZ` afterwards cannot reach them, so a test that only
 * flipped it would pass even with `timeZone` deleted from format.ts. Building
 * them after the flip is what lets this test fail.
 */
async function loadedIn(zone: string): Promise<typeof import('./format')> {
  process.env.TZ = zone;
  vi.resetModules();
  return import('./format');
}

/** What Casablanca says, asked explicitly — the definition being guarded. */
const casablancaClock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Casablanca', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso));
const casablancaKey = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));

describe('formatClock and casablancaDay ignore the process time zone', () => {
  // Midday UTC: the 10th in Casablanca whether Morocco is at UTC+0 or UTC+1
  // (the very thing two tz databases disagree on), and already the 11th in
  // Kiritimati at UTC+14. 23:30 UTC looked safe and was not: under UTC+1 it
  // is half past midnight on the 11th in Casablanca too.
  const instant = '2026-11-10T12:00:00Z';

  for (const zone of ['Pacific/Kiritimati', 'Pacific/Honolulu', 'UTC', 'Asia/Tokyo']) {
    it(`gives Casablanca's clock and day with the process in ${zone}`, async () => {
      const f = await loadedIn(zone);
      expect(f.formatClock(instant)).toBe(casablancaClock(instant));
      expect(f.casablancaDay(instant)).toBe(casablancaKey(instant));
    });
  }

  it('really is a different day in Kiritimati, so the case above can fail', () => {
    // Without this, a coincidence of zones could make the test pass by luck.
    const kiritimati = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(instant));
    expect(kiritimati).not.toBe(casablancaKey(instant));
  });
});

describe('the shapes the chat pane displays', () => {
  it('is a 24-hour HH:MM, never "24:05"', () => {
    for (const iso of ['2026-01-15T00:05:00Z', '2026-01-15T23:59:00Z', '2026-07-01T12:00:00Z']) {
      const clock = formatClock(iso);
      expect(clock).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });

  it('keys a day as YYYY-MM-DD', () => {
    expect(casablancaDay('2026-11-10T12:00:00Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('stamps a portal message as "10 Nov, HH:MM"', () => {
    expect(formatDayMonthClock('2026-11-10T12:00:00Z')).toMatch(/^10 Nov,? ([01]\d|2[0-3]):[0-5]\d$/);
  });
});

describe('dayHeading is arithmetic on keys, with no clock in it', () => {
  it('names today and yesterday', () => {
    expect(dayHeading('2026-11-10', '2026-11-10')).toBe('Today');
    expect(dayHeading('2026-11-09', '2026-11-10')).toBe('Yesterday');
  });

  it('crosses month, year and leap-year boundaries', () => {
    expect(dayHeading('2026-10-31', '2026-11-01')).toBe('Yesterday');
    expect(dayHeading('2025-12-31', '2026-01-01')).toBe('Yesterday');
    expect(dayHeading('2028-02-29', '2028-03-01')).toBe('Yesterday');
    expect(dayHeading('2026-02-28', '2026-03-01')).toBe('Yesterday');
  });

  it('writes any other day out in full', () => {
    expect(dayHeading('2026-11-03', '2026-11-10')).toBe('Tuesday 3 November');
  });

  it('gives the same heading whatever zone the process is in', async () => {
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
      const f = await loadedIn(zone);
      expect(f.dayHeading('2026-11-03', '2026-11-10')).toBe('Tuesday 3 November');
      expect(f.dayHeading('2026-11-09', '2026-11-10')).toBe('Yesterday');
    }
  });
});

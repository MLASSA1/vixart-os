import { describe, expect, it } from 'vitest';
import {
  addDays, addMonths, endOfMonth, isWeekend, isYmd, monthGrid, startOfMonth, startOfWeek,
  weekDays,
} from './calendar';

describe('calendar arithmetic', () => {
  it('starts the week on Monday', () => {
    // 2026-09-19 is a Saturday.
    expect(startOfWeek('2026-09-19')).toBe('2026-09-14');
    // Sunday belongs to the week that has just ended, not the one beginning.
    expect(startOfWeek('2026-09-20')).toBe('2026-09-14');
    expect(startOfWeek('2026-09-21')).toBe('2026-09-21');
  });

  it('treats only Sunday as the weekend', () => {
    expect(isWeekend('2026-09-20')).toBe(true);   // Sunday
    expect(isWeekend('2026-09-19')).toBe(false);  // Saturday is worked
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('clamps a month step rather than overflowing', () => {
    // 31 January plus a month is the end of February, not the 3rd of March.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // leap year
  });

  it('finds the ends of a month', () => {
    expect(startOfMonth('2026-09-19')).toBe('2026-09-01');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
  });

  it('draws a month as whole weeks', () => {
    const grid = monthGrid('2026-09-19');
    expect(grid.length % 7).toBe(0);
    expect(grid[0]).toBe(startOfWeek('2026-09-01'));
    expect(grid).toContain('2026-09-30');
  });

  it('gives seven days for a week', () => {
    const days = weekDays('2026-09-19');
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-09-14');
    expect(days[6]).toBe('2026-09-20');
  });

  it('does not drift across a timezone boundary', () => {
    // The bug this file exists to avoid: new Date('2026-09-19') is midnight
    // UTC, which in Agadir's offset can render as the 18th.
    expect(addDays('2026-09-19', 0)).toBe('2026-09-19');
    expect(startOfWeek(addDays('2026-09-19', 7))).toBe('2026-09-21');
  });
});

describe('isYmd', () => {
  it('accepts a real date', () => {
    expect(isYmd('2026-10-13')).toBe(true);
    expect(isYmd('2024-02-29')).toBe(true);   // a leap day that exists
  });

  it('refuses a date no calendar has, which the shape test admitted', () => {
    // Each of these matches /^\d{4}-\d{2}-\d{2}$/ and is not a date. The
    // schedule took its anchor from the query string on that test alone, and
    // handed the result to monthGrid.
    expect(isYmd('2026-02-31')).toBe(false);
    expect(isYmd('2026-99-99')).toBe(false);
    expect(isYmd('2026-13-01')).toBe(false);
    expect(isYmd('2026-00-10')).toBe(false);
    expect(isYmd('2025-02-29')).toBe(false);  // 2025 is not a leap year
  });

  it('refuses anything that is not the shape at all', () => {
    expect(isYmd('')).toBe(false);
    expect(isYmd(null)).toBe(false);
    expect(isYmd(undefined)).toBe(false);
    expect(isYmd('13/10/2026')).toBe(false);
    expect(isYmd('2026-10-13T00:00:00Z')).toBe(false);
  });

  it('is safe to hand to monthGrid, which is why it exists', () => {
    const anchor = isYmd('2026-02-31') ? '2026-02-31' : '2026-02-01';
    expect(monthGrid(anchor)).toContain('2026-02-28');
  });
});

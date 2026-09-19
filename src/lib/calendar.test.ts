import { describe, expect, it } from 'vitest';
import {
  addDays, addMonths, endOfMonth, isWeekend, monthGrid, startOfMonth, startOfWeek, weekDays,
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

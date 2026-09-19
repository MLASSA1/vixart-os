/**
 * How much of a list a working page draws.
 *
 * WHY THESE EXIST.
 *
 * Every task row carries its own status forms, and a server action reference
 * is not free. Measured on a loaded database: eight hundred tasks came to
 * 4.9 MB of HTML for one page, and six thousand messages in a channel came to
 * 7.6 MB — the database answered the second one in seven milliseconds and the
 * server then spent a second and a half rendering bubbles nobody scrolled to,
 * before sending them to a phone on mobile data in Agadir.
 *
 * WHAT THEY ARE NOT.
 *
 * They are not a feature, and they are not tuning. A team of eight does not
 * have two hundred open tasks; on today's data nothing here is ever reached.
 * They are the rail that keeps a page usable on the day it is — because the
 * alternative is not a slow page, it is a page nobody can open, discovered by
 * the person who could least afford it.
 *
 * ONE HOME. Both work lists cap the same way for the same reason. Two copies
 * of a number like this drift, and the drift shows up as one page being fine
 * while the other is not.
 */

/** Rows drawn per section before the rest are counted rather than listed. */
export const SECTION_CAP = 25;

/** The most rows a work list will ask the database for. */
export const QUERY_CAP = 300;

/** Completed work older than this is history, not a working list. */
export const DONE_WINDOW = '30 days';

/** The first `SECTION_CAP` items, and how many were held back. */
export function capped<T>(items: readonly T[]): { shown: T[]; hidden: number } {
  return {
    shown: items.slice(0, SECTION_CAP),
    hidden: Math.max(0, items.length - SECTION_CAP),
  };
}

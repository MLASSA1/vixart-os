import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Tasks in the order somebody numbered them (0076, fixed in 0077).
 *
 * Amin: "fix the task counting they eapers missy then need to be in nu,ric
 * order". 0076 added `app.task_sort_key` to do it, and got the one shape most
 * likely to be typed wrong: a title that is ONLY a number.
 *
 * The mechanism, because it is worth pinning rather than re-deriving. 0076
 * extracted the number with
 *
 *     nullif(regexp_replace(title, '^[^0-9]*([0-9]{1,9}).*$', '\1'), title)
 *
 * where the `nullif` meant "the pattern did not match", on the reasoning that a
 * regexp_replace matching nothing returns its input. But when the title IS the
 * number, the replacement is ALSO the input — '16' in, '16' out — so a
 * successful extraction was indistinguishable from a failed one, and those
 * titles fell back to sorting as text: 1, 10, 11, 16, 2, 3.
 *
 * 0077 uses `substring(... from ...)`, which returns the match or NULL and
 * never the subject, so there is no sentinel to collide with.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

/** The titles, in the order the database would list them. */
async function ordered(db: Client, titles: string[]): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(
    `SELECT t FROM unnest($1::text[]) AS t ORDER BY app.task_sort_key(t), t`,
    [titles],
  );
  return rows.map((r) => r.t);
}

describe.skipIf(!HAS_DB)('app.task_sort_key (integration)', () => {
  let db: Client;
  beforeAll(async () => { db = new Client({ connectionString: URL }); await db.connect(); });
  afterAll(async () => { await db?.end(); });

  it('numbers a title that is only a number — the 0076 bug', async () => {
    expect(await ordered(db, ['10', '2', '16', '1', '3', '11']))
      .toEqual(['1', '2', '3', '10', '11', '16']);
  });

  it('still numbers a title with text after the number', async () => {
    // This shape always worked, which is why the bug above survived review.
    expect(await ordered(db, ['10 a', '2 a', '16 a', '1 a']))
      .toEqual(['1 a', '2 a', '10 a', '16 a']);
  });

  it('leaves production’s zero-padded series alone', async () => {
    expect(await ordered(db, ['10 — Retarget', '02 — Target', '01 — Media']))
      .toEqual(['01 — Media', '02 — Target', '10 — Retarget']);
  });

  it('keeps separate series apart by the text before the number', async () => {
    expect(await ordered(db, ['TASK 10', 'Task 2', 'TASK 2', 'Task 10']))
      .toEqual(['TASK 2', 'TASK 10', 'Task 2', 'Task 10']);
  });

  it('puts a title with no number last, not first', async () => {
    const got = await ordered(db, ['no number here', '3', '20']);
    expect(got[got.length - 1]).toBe('no number here');
  });

  it('is unaffected by how many digits the number has', async () => {
    expect(await ordered(db, ['100', '99', '9', '1000']))
      .toEqual(['9', '99', '100', '1000']);
  });
});

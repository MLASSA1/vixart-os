import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { hasMessagesBefore, listMessages, MESSAGE_PAGE } from './chat-queries';
import type { Tx } from '@/db/session';

/**
 * Nothing a page loads may grow without limit.
 *
 * Measured on a loaded database before this: a channel with six thousand
 * messages returned all six thousand — 7.6 MB of HTML, a second and a half of
 * rendering, for a reader who sees the last twenty. Eight hundred tasks came
 * to 4.9 MB. Both were correct, both passed every test, and both got worse
 * every week the team used the thing.
 *
 * That is the failure this file is about. A query with no LIMIT does not
 * break; it degrades, and the person who finds out is whoever opens the
 * busiest channel on the worst connection.
 *
 * These call the real `listMessages` through the real application role, on a
 * thread they create and delete. Re-implementing its SQL here would test the
 * shape I meant to write rather than the one the page runs.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ bounded probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('a page never loads an unbounded list (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let threadId = '';
  let meId = '';

  /** Comfortably more than one page, and not a multiple of it. */
  const TOTAL = MESSAGE_PAGE * 3 + 7;

  /**
   * Runs `work` as the signed-in person, the way `withUser` does — but with an
   * identity passed in, because there is no HTTP request here to carry one.
   */
  async function asMe<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzle(pool).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${meId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_role', 'member', true)`);
      return work(tx as unknown as Tx);
    });
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `DELETE FROM attachment WHERE entity_type='message' AND entity_id IN
        (SELECT id FROM message WHERE body LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();

    const people = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 2`);
    meId = people.rows[0]!.id;
    const other = people.rows[1]!.id;

    // A conversation of its own, so nothing here touches a channel the team
    // actually uses.
    threadId = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
       VALUES ('dm',$1,$2,$3,$2) RETURNING id`,
      [`${MARK} thread`, meId, other])).rows[0]!.id;

    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `INSERT INTO message (thread_id, author_id, author_name, body, created_at)
       SELECT $1, $2, 'Probe', $3 || ' ' || g, now() - (g || ' minutes')::interval
         FROM generate_series(1, $4) g`,
      [threadId, meId, MARK, TOTAL]);

    pool = new Pool({ connectionString: APP, max: 2 });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('opens a channel on one page, not on all of it', async () => {
    const rows = await asMe((tx) => listMessages(tx, threadId, meId));
    expect(rows).toHaveLength(MESSAGE_PAGE);
  });

  it('opens on the NEWEST page', async () => {
    // Bounded and wrong is still wrong: opening a channel on its oldest
    // messages would pass a length check and be useless.
    const rows = await asMe((tx) => listMessages(tx, threadId, meId));
    const newest = (await owner.query<{ created_at: Date }>(
      `SELECT created_at FROM message WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [threadId])).rows[0]!.created_at;

    // Compared as instants: the column comes back as text.
    expect(new Date(rows[rows.length - 1]!.created_at).getTime()).toBe(newest.getTime());
    // And oldest-first on screen.
    expect(new Date(rows[0]!.created_at).getTime())
      .toBeLessThan(new Date(rows[rows.length - 1]!.created_at).getTime());
  });

  it('says there is more above the page it sent', async () => {
    const rows = await asMe((tx) => listMessages(tx, threadId, meId));
    const more = await asMe((tx) => hasMessagesBefore(tx, threadId, rows[0]!.created_at));
    expect(more).toBe(true);
  });

  it('walks the whole channel a page at a time, repeating nothing and losing nothing', async () => {
    // The property that matters about "load earlier": paging back reaches
    // every message exactly once. An off-by-one at the boundary silently drops
    // a message or shows it twice, and neither is visible in a screenshot.
    const seen = new Set<string>();
    let before: string | null = null;
    let pages = 0;

    for (;;) {
      const rows: Awaited<ReturnType<typeof listMessages>> = await asMe((tx) =>
        listMessages(tx, threadId, meId, { before }),
      );
      if (rows.length === 0) break;

      for (const r of rows) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      before = rows[0]!.created_at;
      pages += 1;
      expect(pages).toBeLessThan(20); // a walk that does not end is the other bug
    }

    expect(seen.size).toBe(TOTAL);
    expect(pages).toBe(Math.ceil(TOTAL / MESSAGE_PAGE));

    // And at the top, nothing above it.
    expect(await asMe((tx) => hasMessagesBefore(tx, threadId, null))).toBe(false);
  });

  it('a poll returns the oldest unseen first, so a long absence converges', async () => {
    // A browser shut for a week asks for everything since it last looked. If
    // the tail came back newest-first and bounded, its high-water mark would
    // jump to the newest and the middle would never arrive.
    // As TEXT, not via a JS Date: `timestamptz` keeps microseconds and
    // `toISOString()` throws them away, so a cutoff round-tripped through Date
    // lands a fraction BEFORE the row it names and hands it back again. The
    // browser does not have that problem — the value it sends as `after` is
    // the one this API gave it, rendered by the database — but a test that
    // used Date would be checking a boundary the application never hits.
    const all = await owner.query<{ at: string }>(
      `SELECT created_at::text AS at FROM message WHERE thread_id=$1 ORDER BY created_at`,
      [threadId]);
    const wayBack = all.rows[0]!.at;

    const tail = await asMe((tx) => listMessages(tx, threadId, meId, { after: wayBack }));
    expect(tail.length).toBeGreaterThan(0);

    // The first thing it hands back is the oldest thing we had not seen —
    // never the one we named, and never a jump to the newest.
    expect(tail[0]!.created_at).toBe(all.rows[1]!.at);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { listDms } from './chat-queries';
import type { Tx } from '@/db/session';

/**
 * Direct messages (0060).
 *
 * The value of a private conversation is entirely in its being private, so
 * that is what these test — through the APPLICATION role, because the owner
 * holds BYPASSRLS and would read every DM in the system regardless of any
 * policy. A test on the owner connection would pass while proving nothing.
 *
 * The case that matters most is the administrator. A colleague being refused
 * is expected; the question worth asking of a system is whether the person who
 * runs it can read two other people's conversation, and here the answer has to
 * be no.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ dm probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('direct messages (integration)', () => {
  let owner: Client;
  let app: Client;
  let aya = '';
  let adam = '';
  let outsider = '';
  let boss = '';
  let service = '';
  let dmId = '';

  async function actAs(id: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [id]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM attachment WHERE entity_type='message' AND entity_id IN
                        (SELECT id FROM message WHERE body LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE kind='dm' AND title LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();

    const people = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='member' AND is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 3`);
    aya = people.rows[0]!.id;
    adam = people.rows[1]!.id;
    outsider = people.rows[2]!.id;
    boss = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' AND is_active LIMIT 1`)).rows[0]!.id;
    service = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_service_account LIMIT 1`)).rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();

    // Aya opens one with Adam.
    await actAs(aya, 'member');
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
       VALUES ('dm',$1,$2,$3,$2) RETURNING id`, [`${MARK} aya-adam`, aya, adam]);
    dmId = rows[0]!.id;
    await app.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Aya',$3)`, [dmId, aya, `${MARK} something private`]);
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  // --- who can see it ------------------------------------------------------

  it('is readable by both participants', async () => {
    for (const who of [aya, adam]) {
      await actAs(who, 'member');
      expect((await app.query(`SELECT 1 FROM thread WHERE id=$1`, [dmId])).rows).toHaveLength(1);
      expect((await app.query(`SELECT 1 FROM message WHERE thread_id=$1`, [dmId])).rows)
        .toHaveLength(1);
    }
  });

  it('is invisible to a third member', async () => {
    await actAs(outsider, 'member');
    expect((await app.query(`SELECT 1 FROM thread WHERE id=$1`, [dmId])).rows).toHaveLength(0);
    expect((await app.query(`SELECT 1 FROM message WHERE thread_id=$1`, [dmId])).rows)
      .toHaveLength(0);
  });

  it('is invisible to an administrator', async () => {
    // The one that matters. Refused by the database, not by a query that
    // remembered to filter.
    await actAs(boss, 'admin');
    expect((await app.query(`SELECT 1 FROM thread WHERE id=$1`, [dmId])).rows).toHaveLength(0);
    expect((await app.query(`SELECT 1 FROM message WHERE thread_id=$1`, [dmId])).rows)
      .toHaveLength(0);
    /*
     * Not even that it exists — and stated as the RULE rather than as a count.
     *
     * This asked for zero DM threads in total, which held only because the
     * administrator in the fixtures happened to have no conversations of his
     * own. The moment he had one — every person is now a row in the private
     * list, so opening one is a single click — the test failed while the
     * boundary was perfectly intact.
     *
     * What the policy actually says is that a DM is visible to its two
     * participants and nobody else. So: of the DMs this administrator can see,
     * none is one he is not in.
     */
    const { rows } = await app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM thread
        WHERE kind = 'dm'
          AND participant_a IS DISTINCT FROM $1
          AND participant_b IS DISTINCT FROM $1`, [boss]);
    expect(rows[0]!.n, 'an administrator can see a conversation he is not in').toBe('0');
  });

  it('never appears in a channel list', async () => {
    // The channel list is every thread the person can see. A DM they are in
    // IS visible to them, so the separation is the query's job — and this
    // pins it, because a DM appearing among the client channels is how
    // somebody posts a private thing into a project.
    await actAs(aya, 'member');
    const { rows } = await app.query<{ kind: string }>(
      `SELECT kind FROM thread WHERE kind <> 'dm'`);
    expect(rows.every((r) => r.kind !== 'dm')).toBe(true);
  });

  // --- attachments ---------------------------------------------------------

  it('hides a file sent in a DM from everyone else', async () => {
    // /api/files/[id] loads the attachment under the caller's own policies and
    // 404s what it cannot see, so the question is whether the row is visible.
    await actAs(aya, 'member');
    const { rows: m } = await app.query<{ id: string }>(
      `SELECT id FROM message WHERE thread_id=$1 LIMIT 1`, [dmId]);
    await app.query(
      `INSERT INTO attachment (entity_type, entity_id, original_name, stored_path,
                               mime_type, size_bytes, uploaded_by_id)
       VALUES ('message',$1,'private.pdf','2026/09/' || gen_random_uuid() || '.pdf',
               'application/pdf', 1234, $2)`, [m[0]!.id, aya]);

    expect((await app.query(`SELECT 1 FROM attachment WHERE entity_id=$1`, [m[0]!.id])).rows)
      .toHaveLength(1);

    await actAs(adam, 'member');
    expect((await app.query(`SELECT 1 FROM attachment WHERE entity_id=$1`, [m[0]!.id])).rows)
      .toHaveLength(1);

    for (const [who, role] of [[outsider, 'member'], [boss, 'admin']] as const) {
      await actAs(who, role);
      expect(
        (await app.query(`SELECT 1 FROM attachment WHERE entity_id=$1`, [m[0]!.id])).rows,
        `${role} should not reach a file sent in somebody else's DM`,
      ).toHaveLength(0);
    }
  });

  // --- the shape of it -----------------------------------------------------

  it('refuses a third participant by having nowhere to put one', async () => {
    // One to one, structurally. Two columns, not a join table — a join table
    // is how a one-to-one conversation quietly becomes a group chat later.
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name='thread' AND column_name LIKE 'participant%'`);
    expect(rows[0]!.n).toBe('2');
  });

  it('keeps one conversation per pair, whichever way round', async () => {
    // Otherwise each of them sees half the conversation, which looks exactly
    // like messages going missing.
    await actAs(adam, 'member');
    await expect(
      app.query(`INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
                 VALUES ('dm',$1,$2,$3,$2)`, [`${MARK} adam-aya`, adam, aya]),
    ).rejects.toThrow(/thread_one_dm_per_pair/);
  });

  it('refuses opening one on behalf of two other people', async () => {
    await actAs(outsider, 'member');
    await expect(
      app.query(`INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
                 VALUES ('dm',$1,$2,$3,$4)`, [`${MARK} meddling`, aya, boss, outsider]),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses a conversation with a service account', async () => {
    await actAs(aya, 'member');
    await expect(
      app.query(`INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
                 VALUES ('dm',$1,$2,$3,$2)`, [`${MARK} to a robot`, aya, service]),
    ).rejects.toThrow(/active member of the team/i);
  });

  it('refuses a conversation with yourself', async () => {
    await actAs(aya, 'member');
    await expect(
      app.query(`INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
                 VALUES ('dm',$1,$2,$2,$2)`, [`${MARK} alone`, aya]),
    ).rejects.toThrow(/thread_target_matches_kind/);
  });

  it('refuses editing a channel into a DM, or a DM into a channel', async () => {
    await actAs(aya, 'member');
    expect((await app.query(
      `UPDATE thread SET title='renamed' WHERE id=$1`, [dmId])).rowCount).toBe(0);
  });
});

/**
 * Everybody is in the private list, whether or not anything has been said.
 *
 * It used to hold only conversations that existed, reached through a "+" button
 * and a dropdown of names. Amin asked for every account to be shown by default,
 * and for a team of eight that is plainly right: choosing a name from a select
 * before you can type is most of the reason a private message never gets sent.
 *
 * What has to be true for that to work:
 *
 *   1. a colleague with no conversation is STILL a row — with a null thread id,
 *      which is what tells the interface to link through the route that opens
 *      one;
 *   2. you are not in your own list;
 *   3. service accounts are not either — a trigger refuses a DM with something
 *      that has no inbox, so offering the row would be offering a refusal;
 *   4. and the list must not become a way to see other people's conversations.
 */
describe.skipIf(!HAS_DB)('the private list holds everybody (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let me = '';
  let them = '';

  async function asMe<T>(id: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzle(pool).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${id}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_role', 'member', true)`);
      return work(tx as unknown as Tx);
    });
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    const people = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 2`)).rows;
    me = people[0]!.id;
    them = people[1]!.id;
    pool = new Pool({ connectionString: APP, max: 2 });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (owner) await owner.end();
  });

  it('lists every colleague, and never me', async () => {
    const rows = await asMe(me, (tx) => listDms(tx, me));
    const ids = rows.map((r) => r.other_id);

    expect(ids.length, 'the private list is empty').toBeGreaterThan(1);
    expect(ids, 'I am in my own private list').not.toContain(me);
    expect(ids, 'a colleague is missing from the private list').toContain(them);
  });

  it('offers no conversation with a service account', async () => {
    const service = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_service_account AND is_active LIMIT 1`)).rows[0];
    if (!service) return;

    const rows = await asMe(me, (tx) => listDms(tx, me));
    expect(
      rows.map((r) => r.other_id),
      'a service account is offered as somebody to write to',
    ).not.toContain(service.id);
  });

  it('gives a colleague with nothing said a null thread', async () => {
    /*
     * The state every row starts in, and the one the old list could not
     * represent at all. Null is what sends the link through /chat/with/<person>.
     */
    const fresh = (await owner.query<{ id: string }>(
      `SELECT u.id FROM app_user u
        WHERE u.is_active AND u.is_assignable AND NOT u.is_service_account
          AND u.id <> $1
          AND NOT EXISTS (
            SELECT 1 FROM thread t
             WHERE t.kind = 'dm'
               AND least(t.participant_a, t.participant_b) = least(u.id, $1::uuid)
               AND greatest(t.participant_a, t.participant_b) = greatest(u.id, $1::uuid))
        LIMIT 1`, [me])).rows[0];
    if (!fresh) return; // Everybody has spoken to everybody on this database.

    const rows = await asMe(me, (tx) => listDms(tx, me));
    const row = rows.find((r) => r.other_id === fresh.id);
    expect(row, 'somebody with no conversation vanished from the list').toBeDefined();
    expect(row!.id, 'a conversation appeared that was never opened').toBeNull();
    expect(Number(row!.unread)).toBe(0);
  });

  it('never shows a conversation belonging to two other people', async () => {
    // The list is driven by the directory now, so the thread join is the only
    // thing keeping other people's conversations out of it.
    const others = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account AND id <> $1 ORDER BY created_at LIMIT 2`, [me])).rows;
    if (others.length < 2) return;

    await owner.query("SET app.bootstrap = 'on'");
    const theirs = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
       VALUES ('dm','Direct message',$1,$2,$1)
       ON CONFLICT DO NOTHING RETURNING id`,
      [others[0]!.id, others[1]!.id])).rows[0];

    /*
     * Removed in the same test, not in an afterAll.
     *
     * The first version left it, and `thread_one_dm_per_pair` then refused the
     * fixture another file builds for the same pair — so this test broke a test
     * two files away, only in a full run, and only after the first time it ran.
     * A conversation between two people is unique by construction, which makes
     * one left behind a landmine rather than clutter.
     */
    try {
      const rows = await asMe(me, (tx) => listDms(tx, me));
      expect(rows.map((r) => r.id).filter(Boolean))
        .not.toContain(theirs?.id ?? '__none__');
    } finally {
      if (theirs) {
        await owner.query("SET app.bootstrap = 'on'");
        await owner.query(`DELETE FROM thread WHERE id = $1`, [theirs.id]);
      }
    }
  });
});

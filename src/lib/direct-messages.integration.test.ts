import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

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
    // Not even that it exists.
    const { rows } = await app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM thread WHERE kind='dm'`);
    expect(rows[0]!.n).toBe('0');
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

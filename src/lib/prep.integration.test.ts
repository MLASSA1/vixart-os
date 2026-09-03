import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The prep board's one rule: private while being written, shared once ready.
 *
 * These assertions connect as the APPLICATION role, never the owner — the
 * owner holds BYPASSRLS, so a visibility test made on it would pass whatever
 * the policies said. That mistake has already been made once in this suite.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ prep probe';

describe.skipIf(!HAS_DB)('the prep board (integration)', () => {
  let owner: Client;          // as vixart_owner, for setup and cleanup
  let app: Client;            // as vixart_app, where RLS actually applies
  let aliceId = '';           // a member who writes prep
  let bobId = '';             // another member
  let adminId = '';           // management
  let draftId = '';
  let readyId = '';

  /** Speak as this person, the way a request does. */
  async function actAs(userId: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [userId]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  }

  async function purge() {
    await owner.query(`DELETE FROM comment WHERE entity_type='prep' AND entity_id IN (SELECT id FROM prep WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM prep WHERE title LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");
    await purge();

    const members = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='member' AND password_hash NOT LIKE 'NO-LOGIN%'
        ORDER BY created_at LIMIT 2`);
    aliceId = members.rows[0]!.id;
    bobId = members.rows[1]!.id;
    adminId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' LIMIT 1`)).rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  it('lets a member start a piece of preparation', async () => {
    await actAs(aliceId, 'member');
    const r = await app.query<{ id: string }>(
      `INSERT INTO prep (title, kind, body, owner_id)
       VALUES ($1, 'shotlist', 'Golden hour on the terrace, 3 setups.', $2) RETURNING id`,
      [`${MARK} draft`, aliceId]);
    draftId = r.rows[0]!.id;
    expect(draftId).toBeTruthy();
  });

  it('keeps a draft invisible to a colleague', async () => {
    await actAs(bobId, 'member');
    const { rows } = await app.query(`SELECT 1 FROM prep WHERE id=$1`, [draftId]);
    expect(rows).toHaveLength(0);
  });

  it('keeps a draft invisible to management too', async () => {
    // Deliberate: this is the one place being the founder does not come with
    // a key. A draft nobody can see is a draft you can be wrong in.
    await actAs(adminId, 'admin');
    const { rows } = await app.query(`SELECT 1 FROM prep WHERE id=$1`, [draftId]);
    expect(rows).toHaveLength(0);
  });

  it('shows the owner their own draft', async () => {
    await actAs(aliceId, 'member');
    const { rows } = await app.query(`SELECT title FROM prep WHERE id=$1`, [draftId]);
    expect(rows).toHaveLength(1);
  });

  it('shares it with everyone the moment it is marked ready', async () => {
    await actAs(aliceId, 'member');
    await app.query(`UPDATE prep SET status='ready' WHERE id=$1`, [draftId]);
    readyId = draftId;

    for (const [who, role] of [[bobId, 'member'], [adminId, 'admin']] as const) {
      await actAs(who, role);
      const { rows } = await app.query<{ status: string; ready: string | null }>(
        `SELECT status, ready_at::text AS ready FROM prep WHERE id=$1`, [readyId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('ready');
      expect(rows[0]!.ready).not.toBeNull();
    }
  });

  it('hides it again if the owner pulls it back, and forgets the share date', async () => {
    await actAs(aliceId, 'member');
    await app.query(`UPDATE prep SET status='draft' WHERE id=$1`, [readyId]);

    await actAs(bobId, 'member');
    expect((await app.query(`SELECT 1 FROM prep WHERE id=$1`, [readyId])).rows).toHaveLength(0);

    const back = await owner.query<{ ready: string | null }>(
      `SELECT ready_at::text AS ready FROM prep WHERE id=$1`, [readyId]);
    expect(back.rows[0]!.ready).toBeNull();

    await actAs(aliceId, 'member');
    await app.query(`UPDATE prep SET status='ready' WHERE id=$1`, [readyId]);
  });

  it('refuses a colleague editing prep that is not theirs', async () => {
    await actAs(bobId, 'member');
    const r = await app.query(`UPDATE prep SET body='rewritten by someone else' WHERE id=$1`, [readyId]);
    expect(r.rowCount).toBe(0);   // visible to read, untouchable to write
  });

  it('refuses creating prep in someone else\'s name', async () => {
    await actAs(bobId, 'member');
    await expect(
      app.query(`INSERT INTO prep (title, owner_id) VALUES ($1, $2)`, [`${MARK} forged`, aliceId]),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses handing prep to another person', async () => {
    await actAs(aliceId, 'member');
    await expect(
      app.query(`UPDATE prep SET owner_id=$2 WHERE id=$1`, [readyId, bobId]),
    ).rejects.toThrow(/stays with the person/i);
  });

  it('hides a draft\'s comments, and shows them once it is ready', async () => {
    await actAs(aliceId, 'member');
    const second = await app.query<{ id: string }>(
      `INSERT INTO prep (title, owner_id) VALUES ($1, $2) RETURNING id`,
      [`${MARK} with comments`, aliceId]);
    const id = second.rows[0]!.id;
    await app.query(
      `INSERT INTO comment (entity_type, entity_id, author_id, author_name, body)
       VALUES ('prep', $1, $2, 'Alice', 'note to self')`, [id, aliceId]);

    await actAs(bobId, 'member');
    expect((await app.query(
      `SELECT 1 FROM comment WHERE entity_type='prep' AND entity_id=$1`, [id])).rows).toHaveLength(0);

    await actAs(aliceId, 'member');
    await app.query(`UPDATE prep SET status='ready' WHERE id=$1`, [id]);

    await actAs(bobId, 'member');
    expect((await app.query(
      `SELECT 1 FROM comment WHERE entity_type='prep' AND entity_id=$1`, [id])).rows).toHaveLength(1);
  });

  it('lets a colleague comment on ready prep', async () => {
    await actAs(bobId, 'member');
    await app.query(
      `INSERT INTO comment (entity_type, entity_id, author_id, author_name, body)
       VALUES ('prep', $1, $2, 'Bob', 'The terrace light goes at 18:40 — shoot earlier.')`,
      [readyId, bobId]);
    const { rows } = await app.query(
      `SELECT 1 FROM comment WHERE entity_type='prep' AND entity_id=$1`, [readyId]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses a blank title', async () => {
    await actAs(aliceId, 'member');
    await expect(
      app.query(`INSERT INTO prep (title, owner_id) VALUES ('   ', $1)`, [aliceId]),
    ).rejects.toThrow(/prep_title_present|violates check/i);
  });
});

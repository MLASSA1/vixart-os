import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Team chat: a record, not a whiteboard.
 *
 * Every visibility assertion here connects as the APPLICATION role. The owner
 * holds BYPASSRLS, so the same assertion made on it would pass whatever the
 * policies said — a mistake this suite has already made once.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ chat probe';

describe.skipIf(!HAS_DB)('team chat (integration)', () => {
  let owner: Client;
  let app: Client;
  let alice = '';
  let bob = '';
  // Since 0047 a channel is opened by a moderator. These fixtures are about
  // what happens INSIDE one, so they need somebody who can make them.
  let boss = '';
  let serviceId = '';
  let companyId = '';
  let generalId = '';
  let clientThreadId = '';

  async function actAs(userId: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [userId]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  }

  /** Opens a general channel as the moderator, per 0047. */
  async function openChannel(title: string): Promise<string> {
    await actAs(boss, 'moderator');
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO thread (kind, title, created_by_id) VALUES ('general',$1,$2) RETURNING id`,
      [title, boss]);
    return rows[0]!.id;
  }

  async function purge() {
    // Scoped to this file's own probe threads, and nothing else.
    //
    // It used to read `DELETE FROM attachment WHERE entity_type='message'` —
    // every message attachment in the database, whoever uploaded it. Amin
    // attached a file in General at 01:51 and the next `npm test` deleted its
    // row at 02:02. The bytes survived on the uploads volume, so the row could
    // be rebuilt, but the original filename was gone: nothing else records it.
    await owner.query(
      `DELETE FROM attachment WHERE entity_type='message' AND entity_id IN
         (SELECT m.id FROM message m JOIN thread t ON t.id = m.thread_id
           WHERE t.title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread_read WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM message WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name = $1`, [MARK]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");
    await purge();

    const people = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_assignable AND is_active ORDER BY created_at LIMIT 2`);
    alice = people.rows[0]!.id;
    bob = people.rows[1]!.id;
    serviceId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_service_account LIMIT 1`)).rows[0]!.id;
    boss = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role IN ('admin','moderator') AND is_active
        ORDER BY created_at LIMIT 1`)).rows[0]!.id;

    companyId = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [MARK])).rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  // --- threads -------------------------------------------------------------

  it('lets a moderator open a general thread, and everyone read it', async () => {
    await actAs(boss, 'moderator');
    generalId = (await app.query<{ id: string }>(
      `INSERT INTO thread (kind, title, created_by_id) VALUES ('general',$1,$2) RETURNING id`,
      [`${MARK} general`, boss])).rows[0]!.id;

    await actAs(bob, 'member');
    expect((await app.query(`SELECT 1 FROM thread WHERE id=$1`, [generalId])).rows).toHaveLength(1);
  });

  it('makes a client thread follow who can see the client', async () => {
    await actAs(boss, 'moderator');
    clientThreadId = (await app.query<{ id: string }>(
      `INSERT INTO thread (kind, title, company_id, created_by_id) VALUES ('company',$1,$2,$3) RETURNING id`,
      [`${MARK} client`, companyId, boss])).rows[0]!.id;

    // company_select is is_authenticated(), so a colleague sees it — the point
    // is that the thread asks the company, rather than carrying its own copy
    // of the rule.
    await actAs(bob, 'member');
    expect((await app.query(`SELECT 1 FROM thread WHERE id=$1`, [clientThreadId])).rows).toHaveLength(1);
  });

  it('hides a client thread the moment the client is out of reach', async () => {
    // Prove the inheritance is live: with the parent gone, so is the thread.
    await owner.query(`SET app.bootstrap = 'on'`);
    await owner.query(`DELETE FROM company WHERE id=$1`, [companyId]);

    await actAs(bob, 'member');
    expect((await app.query(`SELECT 1 FROM thread WHERE id=$1`, [clientThreadId])).rows).toHaveLength(0);

    // …and the cascade took its messages with it, without a trigger fighting it.
    const left = await owner.query(`SELECT 1 FROM thread WHERE id=$1`, [clientThreadId]);
    expect(left.rows).toHaveLength(0);

    companyId = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [MARK])).rows[0]!.id;
  });

  it('refuses a thread whose kind and target disagree', async () => {
    await actAs(boss, 'moderator');
    await expect(
      app.query(`INSERT INTO thread (kind, title, company_id, created_by_id) VALUES ('general',$1,$2,$3)`,
        [`${MARK} bad`, companyId, boss]),
    ).rejects.toThrow(/thread_target_matches_kind/);
  });

  // --- messages ------------------------------------------------------------

  it('posts a message and lifts the thread', async () => {
    await actAs(alice, 'member');
    const before = await owner.query<{ u: string }>(
      `SELECT updated_at::text AS u FROM thread WHERE id=$1`, [generalId]);
    await app.query(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','first')`,
      [generalId, alice]);
    const after = await owner.query<{ u: string }>(
      `SELECT updated_at::text AS u FROM thread WHERE id=$1`, [generalId]);
    expect(after.rows[0]!.u).not.toBe(before.rows[0]!.u);
  });

  it('refuses a message posted in someone else\'s name', async () => {
    await actAs(bob, 'member');
    await expect(
      app.query(`INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','forged')`,
        [generalId, alice]),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses a service account any post at all', async () => {
    // It cannot authenticate either, so this is the second of two refusals.
    await actAs(serviceId, 'member');
    await expect(
      app.query(`INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Le Chef','hello')`,
        [generalId, serviceId]),
    ).rejects.toThrow(/row-level security/i);
    // And it sees no threads.
    expect((await app.query(`SELECT 1 FROM thread`)).rows).toHaveLength(0);
  });

  it('allows a correction inside fifteen minutes, and marks it', async () => {
    await actAs(alice, 'member');
    const id = (await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','tpyo') RETURNING id`,
      [generalId, alice])).rows[0]!.id;

    await app.query(`UPDATE message SET body='typo' WHERE id=$1`, [id]);
    const { rows } = await owner.query<{ body: string; edited: string | null }>(
      `SELECT body, edited_at::text AS edited FROM message WHERE id=$1`, [id]);
    expect(rows[0]!.body).toBe('typo');
    // A silent correction would be a rewritten record.
    expect(rows[0]!.edited).not.toBeNull();
  });

  it('refuses a correction after fifteen minutes', async () => {
    await actAs(alice, 'member');
    const id = (await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','old') RETURNING id`,
      [generalId, alice])).rows[0]!.id;
    await owner.query(
      `UPDATE message SET created_at = now() - interval '16 minutes' WHERE id=$1`, [id]);

    await actAs(alice, 'member');
    await expect(
      app.query(`UPDATE message SET body='too late' WHERE id=$1`, [id]),
    ).rejects.toThrow(/fifteen minutes/i);
  });

  it('refuses moving a message to another thread, even inside the window', async () => {
    await actAs(alice, 'member');
    const id = (await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','here') RETURNING id`,
      [generalId, alice])).rows[0]!.id;
    const other = await openChannel(`${MARK} other`);
    await actAs(alice, 'member');
    await expect(
      app.query(`UPDATE message SET thread_id=$2 WHERE id=$1`, [id, other]),
    ).rejects.toThrow(/only the text/i);
  });

  it('refuses editing a colleague\'s message', async () => {
    await actAs(alice, 'member');
    const id = (await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','mine') RETURNING id`,
      [generalId, alice])).rows[0]!.id;
    await actAs(bob, 'member');
    const r = await app.query(`UPDATE message SET body='not yours' WHERE id=$1`, [id]);
    expect(r.rowCount).toBe(0);
  });

  it('lets nobody delete a message', async () => {
    await actAs(alice, 'member');
    const id = (await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','permanent') RETURNING id`,
      [generalId, alice])).rows[0]!.id;

    for (const [who, role] of [[alice, 'member'], [bob, 'admin']] as const) {
      await actAs(who, role);
      const r = await app.query(`DELETE FROM message WHERE id=$1`, [id]);
      expect(r.rowCount).toBe(0);
    }
    expect((await owner.query(`SELECT 1 FROM message WHERE id=$1`, [id])).rows).toHaveLength(1);
  });

  // --- unread --------------------------------------------------------------

  it('counts unread per person, and not your own messages', async () => {
    const t = await openChannel(`${MARK} unread`);
    await actAs(alice, 'member');
    await app.query(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','one')`, [t, alice]);

    const unreadFor = async (who: string) => {
      await actAs(who, 'member');
      const { rows } = await app.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM message m
          WHERE m.thread_id=$1 AND m.author_id <> $2
            AND m.created_at > coalesce(
              (SELECT last_read_at FROM thread_read WHERE thread_id=$1 AND user_id=$2), 'epoch'::timestamptz)`,
        [t, who]);
      return Number(rows[0]!.n);
    };

    expect(await unreadFor(bob)).toBe(1);      // Bob has not read it
    expect(await unreadFor(alice)).toBe(0);    // Alice wrote it

    await actAs(bob, 'member');
    await app.query(
      `INSERT INTO thread_read (thread_id, user_id) VALUES ($1,$2)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = now()`, [t, bob]);
    expect(await unreadFor(bob)).toBe(0);
  });

  it('keeps a read mark private to its owner', async () => {
    await actAs(alice, 'member');
    // Alice cannot see when Bob last opened anything.
    const { rows } = await app.query(`SELECT 1 FROM thread_read WHERE user_id=$1`, [bob]);
    expect(rows).toHaveLength(0);
    // Nor set one for him.
    await expect(
      app.query(`INSERT INTO thread_read (thread_id, user_id) VALUES ($1,$2)`, [generalId, bob]),
    ).rejects.toThrow(/row-level security/i);
  });

  // --- attachments ---------------------------------------------------------

  it('keeps a file readable only by people who can read its thread', async () => {
    await actAs(alice, 'member');
    const msg = (await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Alice','see attached') RETURNING id`,
      [generalId, alice])).rows[0]!.id;
    await app.query(
      `INSERT INTO attachment (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, uploaded_by_id)
       VALUES ('message',$1,'brief.pdf','2026/09/00000000-0000-4000-8000-000000000001.pdf','application/pdf',1024,$2)`,
      [msg, alice]);

    // A colleague can see it: the thread is general.
    await actAs(bob, 'member');
    expect((await app.query(
      `SELECT 1 FROM attachment WHERE entity_type='message' AND entity_id=$1`, [msg])).rows).toHaveLength(1);

    // A service account cannot.
    await actAs(serviceId, 'member');
    expect((await app.query(
      `SELECT 1 FROM attachment WHERE entity_type='message' AND entity_id=$1`, [msg])).rows).toHaveLength(0);
  });
});

/**
 * A regression guard for the duplicate that hid the bug.
 *
 * `attachment` carried two CHECK constraints listing what may hold a file, and
 * both had to pass — so the effective rule was whichever was narrower, and
 * every extension went into the wrong half. Prep attachments were refused for
 * weeks because of it, silently, since nothing had tried one.
 */
describe.skipIf(!HAS_DB)('attachment entity rule', () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
  });
  afterAll(async () => { await db?.end(); });

  it('is stated in exactly one place', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_constraint
        WHERE conrelid='attachment'::regclass AND contype='c' AND conname LIKE '%entity%'`);
    expect(rows[0]!.n).toBe('1');
  });

  it('accepts every type the application actually uses', async () => {
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='attachment'::regclass AND contype='c' AND conname LIKE '%entity%'`);
    const def = rows[0]!.def;
    for (const t of ['task','project','company','contact','document','finance_entry','prep','message']) {
      expect(def).toContain(`'${t}'`);
    }
  });
});

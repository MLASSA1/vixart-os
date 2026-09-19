import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The announcement the fast path is built on (0061).
 *
 * The browser no longer waits five seconds to ask whether anything happened;
 * the database says so. Everything downstream of that — the shared listener,
 * the stream, the fallback poll — is worth nothing if the trigger does not
 * fire, and a trigger that does not fire fails silently: chat simply goes back
 * to being slow, which is the bug it was written to fix and looks exactly like
 * it never being deployed.
 *
 * So: a real LISTEN on a real connection, and a real INSERT on another.
 *
 * Every row these create is created here and deleted here. Nothing selects an
 * existing row it did not make.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ notify probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('a changed thread announces itself (integration)', () => {
  let owner: Client;
  let app: Client;
  let ear: Client;
  let threadId = '';
  let authorId = '';

  /** Thread ids heard on the wire, in arrival order. */
  const heard: string[] = [];

  /** Waits for an announcement naming `id`, or gives up. */
  function waitFor(id: string, ms = 4000): Promise<number> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = setInterval(() => {
        if (heard.includes(id)) {
          clearInterval(tick);
          resolve(Date.now() - started);
        } else if (Date.now() - started > ms) {
          clearInterval(tick);
          reject(new Error(`no announcement for ${id} within ${ms}ms; heard: ${heard.join(',')}`));
        }
      }, 10);
    });
  }

  async function actAs(id: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [id]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
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
      `SELECT id FROM app_user WHERE role='member' AND is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 2`);
    authorId = people.rows[0]!.id;
    const otherId = people.rows[1]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();

    // A conversation of its own, so nothing here touches a thread the team
    // actually uses.
    await actAs(authorId, 'member');
    threadId = (await app.query<{ id: string }>(
      `INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
       VALUES ('dm',$1,$2,$3,$2) RETURNING id`,
      [`${MARK} thread`, authorId, otherId])).rows[0]!.id;

    ear = new Client({ connectionString: APP });
    await ear.connect();
    ear.on('notification', (n) => {
      if (n.channel === 'vixart_chat' && n.payload) heard.push(n.payload);
    });
    await ear.query('LISTEN vixart_chat');
  });

  afterAll(async () => {
    if (ear) await ear.end();
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  it('announces a new message, naming its thread and nothing else', async () => {
    await actAs(authorId, 'member');
    await app.query(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Probe',$3)`,
      [threadId, authorId, `${MARK} first`]);

    const took = await waitFor(threadId);
    // The point of the exercise: this is the delay Amin was measuring in
    // seconds. It is not a performance assertion, it is the feature.
    expect(took).toBeLessThan(1000);

    // The payload is a thread id. If a body ever starts travelling this way,
    // it travels on a connection that has no identity — so it must not.
    for (const payload of heard) {
      expect(payload).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('announces an edit, not only an insert', async () => {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Probe',$3) RETURNING id`,
      [threadId, authorId, `${MARK} to be corrected`]);
    const messageId = rows[0]!.id;

    heard.length = 0;
    await app.query(
      `UPDATE message SET body=$2, edited_at=now() WHERE id=$1`,
      [messageId, `${MARK} corrected`]);

    // A correction that arrives a minute late has already been read as the
    // original, which is worse than it arriving late in the first place.
    await expect(waitFor(threadId)).resolves.toBeLessThan(1000);
  });

  it('announces a withdrawal', async () => {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Probe',$3) RETURNING id`,
      [threadId, authorId, `${MARK} to be withdrawn`]);

    heard.length = 0;
    await app.query(
      `UPDATE message SET withdrawn_at=now(), withdrawn_by_id=$2, body='' WHERE id=$1`,
      [rows[0]!.id, authorId]);

    await expect(waitFor(threadId)).resolves.toBeLessThan(1000);
  });

  it('says nothing until the transaction commits', async () => {
    const solo = new Client({ connectionString: APP });
    await solo.connect();
    await solo.query(`SELECT set_config('app.user_id',$1,false)`, [authorId]);
    await solo.query(`SELECT set_config('app.user_role','member',false)`);

    heard.length = 0;
    await solo.query('BEGIN');
    await solo.query(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Probe',$3)`,
      [threadId, authorId, `${MARK} rolled back`]);

    // PostgreSQL queues NOTIFY until COMMIT. If it did not, a rolled-back
    // write would send every open browser to fetch a message that does not
    // exist — and the browser, finding nothing, would show nothing and never
    // ask again.
    await new Promise((r) => setTimeout(r, 300));
    expect(heard).toHaveLength(0);

    await solo.query('ROLLBACK');
    await new Promise((r) => setTimeout(r, 300));
    expect(heard).toHaveLength(0);
    await solo.end();
  });

  it('the shared listener reports itself live, and says when it becomes so', async () => {
    // The bug this test exists for: attaching a reader only STARTS the
    // connection. Asking `isLive()` on the next line always answered false,
    // so every browser was told 'degraded' at connect and never told
    // otherwise — every fallback poll stayed at five seconds forever, and the
    // stream cost a connection while saving nothing. It looked like it worked.
    const { isLive, onLiveChange, onThreadChange } = await import('./chat-listener');

    const states: boolean[] = [];
    const unwatch = onLiveChange((live) => states.push(live));
    expect(isLive()).toBe(false);

    const seen: string[] = [];
    const detach = onThreadChange((id) => seen.push(id));

    // It comes up on its own, and says so.
    for (let i = 0; i < 100 && !isLive(); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isLive()).toBe(true);
    expect(states).toContain(true);

    // And a real message reaches a real reader through it.
    await actAs(authorId, 'member');
    await app.query(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Probe',$3)`,
      [threadId, authorId, `${MARK} through the shared listener`]);

    for (let i = 0; i < 100 && !seen.includes(threadId); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toContain(threadId);

    // Closes behind the last reader: a server with nobody looking at chat
    // holds no database connection for it.
    detach();
    expect(isLive()).toBe(false);
    expect(states).toContain(false);
    unwatch();
  });

  it('loses nothing when the listening connection drops', async () => {
    // The failure the fallback exists for. A listener that is down does not
    // report itself down — it simply stops announcing, and a chat application
    // whose only delivery is announcements goes quiet without a word.
    await ear.end();

    await actAs(authorId, 'member');
    const missed = await app.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Probe',$3) RETURNING id, created_at`,
      [threadId, authorId, `${MARK} sent while deaf`]);
    const missedId = missed.rows[0]!.id;

    // Nobody was listening, so nothing was announced. The message is still
    // there, and the poll's incremental fetch — the same `after` the browser
    // sends — still returns it. That is what makes the stream an optimisation
    // rather than the delivery mechanism.
    const recovered = await app.query<{ id: string }>(
      `SELECT id FROM message WHERE thread_id=$1 AND created_at > now() - interval '1 minute'
        ORDER BY created_at`, [threadId]);
    expect(recovered.rows.map((r) => r.id)).toContain(missedId);

    // And once it reconnects, announcements resume on the same channel.
    ear = new Client({ connectionString: APP });
    await ear.connect();
    ear.on('notification', (n) => {
      if (n.channel === 'vixart_chat' && n.payload) heard.push(n.payload);
    });
    await ear.query('LISTEN vixart_chat');

    heard.length = 0;
    await app.query(
      `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Probe',$3)`,
      [threadId, authorId, `${MARK} after recovery`]);
    await expect(waitFor(threadId)).resolves.toBeLessThan(1000);
  });
});

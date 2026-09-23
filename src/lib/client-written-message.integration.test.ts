import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { listChannels, listMessages } from './chat-queries';
import type { Tx } from '@/db/session';

/**
 * A message written by a CLIENT, read by the team.
 *
 * This is the shape that took the internal chat down. 0064 made
 * `message.author_id` nullable so a contact in the portal could be the author
 * of a support message, and everything on the staff side had been written when
 * that column could not be null:
 *
 *   * `hueFor(m.author_id)` read `.length` off null, so the thread page threw
 *     — a 500 on the whole conversation, for every member of staff, the moment
 *     a client said anything. The feature broke in exactly the situation it
 *     exists for, and it broke for us rather than for them: the client's
 *     message sent fine and sat there looking answered.
 *
 *   * the unread count said `m.author_id <> $me`, and `NULL <> 'uuid'` is
 *     NULL, not TRUE. So a client's message never raised the badge. That one
 *     is worse than the crash, because a crash gets reported: this just meant
 *     nobody was told, quietly, indefinitely.
 *
 * Both came from the same thing — a row type that still said `string` — and
 * the compiler now catches the first. Nothing but a real client-written row
 * catches the second, so here is one.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ client-written probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('a client writes and the team can read it (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let staffId = '';
  let threadId = '';
  let contactId = '';
  let secondContactId = '';

  async function asStaff<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzle(pool).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${staffId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_role', 'member', true)`);
      return work(tx as unknown as Tx);
    });
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread_read WHERE thread_id IN
                        (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_account WHERE contact_id IN
                        (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    await owner.query("SET app.bootstrap = 'on'");

    staffId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 1`)).rows[0]!.id;

    const company = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [`${MARK} co`])).rows[0]!.id;

    const makeContact = async (who: string) => {
      const id = (await owner.query<{ id: string }>(
        `INSERT INTO contact (company_id, full_name, email) VALUES ($1,$2,$3) RETURNING id`,
        [company, `${MARK} ${who}`, `zzz-written-${who}@example.invalid`])).rows[0]!.id;
      await owner.query(
        `INSERT INTO client_account (contact_id, password_hash, created_by_id)
         VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',$2)`,
        [id, staffId]);
      return id;
    };
    contactId = await makeContact('first');
    secondContactId = await makeContact('second');

    threadId = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, company_id, created_by_id)
       VALUES ('support',$1,$2,$3) RETURNING id`,
      [`${MARK} support`, company, staffId])).rows[0]!.id;

    // Staff first, then both clients — the run of two different contacts is
    // what proves the grouping key is not "whoever is not staff".
    await owner.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Staff',$3)`, [threadId, staffId, `${MARK} how can we help`]);
    await owner.query(
      `INSERT INTO message (thread_id, author_contact_id, author_name, body)
       VALUES ($1,$2,$3,$4)`,
      [threadId, contactId, 'First Client', `${MARK} the site is down`]);
    await owner.query(
      `INSERT INTO message (thread_id, author_contact_id, author_name, body)
       VALUES ($1,$2,$3,$4)`,
      [threadId, secondContactId, 'Second Client', `${MARK} it is for me too`]);

    pool = new Pool({ connectionString: APP, max: 2 });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('gives the team the client rows, with no author id and a contact id', async () => {
    const rows = await asStaff((tx) => listMessages(tx, threadId, staffId));
    const written = rows.filter((m) => m.body.includes('the site is down'));
    expect(written).toHaveLength(1);

    const m = written[0]!;
    // The exact pair that broke the page: nothing in author_id, the person in
    // author_contact_id. If a future query drops the second column this fails
    // here rather than in a browser.
    expect(m.author_id).toBeNull();
    expect(m.author_contact_id).toBe(contactId);
    expect(m.author_name).toBe('First Client');
  });

  it('never leaves the rendering key empty', async () => {
    /*
     * `authorKey` is `author_id ?? author_contact_id ?? author_name`, and the
     * avatar colour, the name colour and the grouping all hang off it. A row
     * where all three are absent would put us back where we started, so the
     * guarantee is checked against real rows rather than assumed.
     */
    const rows = await asStaff((tx) => listMessages(tx, threadId, staffId));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const m of rows) {
      const key = m.author_id ?? m.author_contact_id ?? m.author_name;
      expect(typeof key, `no author key at all on ${m.id}`).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('tells two clients apart, so neither is shown under the other name', async () => {
    const rows = await asStaff((tx) => listMessages(tx, threadId, staffId));
    const clients = rows.filter((m) => m.author_id === null);
    expect(clients).toHaveLength(2);
    // Both have a null author_id. Grouping on that alone made them one person.
    expect(clients[0]!.author_contact_id).not.toBe(clients[1]!.author_contact_id);
  });

  it('counts a client message as unread', async () => {
    const channels = await asStaff((tx) => listChannels(tx, staffId));
    const support = channels.find((c) => c.title === `${MARK} support`);
    expect(support, 'the support thread is not in the channel list').toBeDefined();
    // Two clients wrote; the staff message is this reader's own and is not
    // unread. Under `<>` this was 0 and nobody was ever told.
    expect(support!.unread).toBe(2);
  });
});

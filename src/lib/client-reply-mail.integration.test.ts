import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

vi.mock('server-only', () => ({}));
const { sweepClientReplyMail } = await import('./client-reply-mail');

/**
 * A client is emailed when the team replies (0088) — once per burst, not when
 * they have already read it, and not when they said no.
 *
 * The trigger is exercised through the APPLICATION role writing a real reply;
 * the sweep runs its real queries against the test database with a fake
 * sender in place of SMTP.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const CLIENT = process.env.CLIENT_DATABASE_URL;
const MARK = 'ZZZ reply-mail probe';

async function reachable(url?: string): Promise<boolean> {
  if (!url) return false;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = (await reachable(URL)) && (await reachable(APP)) && (await reachable(CLIENT));

describe.skipIf(!HAS_DB)('emailing a client when the team replies (integration)', () => {
  let owner: Client;
  let app: Client;
  let portal: Client;
  let staffId = '';
  let company = '';
  let contact = '';
  let silent = '';   // a second contact who turned the emails off
  let thread = '';
  const outbox: { to: string; subject: string }[] = [];
  const send = async (m: { to: string; subject: string }) => { outbox.push({ to: m.to, subject: m.subject }); };

  async function reply(body: string) {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.user_id',$1,true), set_config('app.user_role','admin',true)`, [staffId]);
    await app.query(`INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,'Amin',$3)`, [thread, staffId, body]);
    await app.query('COMMIT');
  }
  const pending = async () => (await owner.query<{ contact_id: string; replies: number; preview: string }>(
    `SELECT contact_id, replies, preview FROM client_reply_mail
      WHERE thread_id=$1 AND emailed_at IS NULL AND skipped_at IS NULL ORDER BY contact_id`, [thread])).rows;
  /** Pretend the conversation has been quiet for a while. */
  const quiet = () => owner.query(
    `UPDATE client_reply_mail SET first_reply_at = now() - interval '10 minutes', last_reply_at = now() - interval '10 minutes' WHERE thread_id=$1`, [thread]);

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM client_reply_mail WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_thread_read WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM notification WHERE entity_id IN (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM message WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_account WHERE contact_id IN (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    staffId = (await owner.query<{ id: string }>(`SELECT id FROM app_user WHERE is_owner`)).rows[0]!.id;
    company = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`, [MARK])).rows[0]!.id;
    const person = async (name: string, email: string) => {
      const id = (await owner.query<{ id: string }>(
        `INSERT INTO contact (company_id, full_name, email) VALUES ($1,$2,$3) RETURNING id`, [company, `${MARK} ${name}`, email])).rows[0]!.id;
      await owner.query(`INSERT INTO client_account (contact_id, password_hash) VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash')`, [id]);
      return id;
    };
    contact = await person('Sara', 'zzz-reply-sara@example.invalid');
    silent = await person('Omar', 'zzz-reply-omar@example.invalid');
    thread = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, company_id, created_by_id) VALUES ('support',$1,$2,$3) RETURNING id`, [MARK, company, staffId])).rows[0]!.id;

    app = new Client({ connectionString: APP }); await app.connect();
    portal = new Client({ connectionString: CLIENT }); await portal.connect();

    // Omar turns the emails off himself, through the portal role.
    await portal.query(`SELECT set_config('app.client_contact_id',$1,false)`, [silent]);
    await portal.query(`SELECT app.set_own_reply_emails(false)`);
  });

  beforeEach(async () => {
    outbox.length = 0;
    await owner.query(`DELETE FROM client_reply_mail WHERE thread_id=$1`, [thread]);
    await owner.query(`DELETE FROM client_thread_read WHERE thread_id=$1`, [thread]);
  });

  afterAll(async () => {
    await portal?.end();
    await app?.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('queues one email per client who wants them, and folds a burst into it', async () => {
    await reply('First cut is ready.');
    await reply('Link inside.');
    await reply('Tell us what you think.');
    const rows = await pending();
    expect(rows).toEqual([{ contact_id: contact, replies: 3, preview: 'Tell us what you think.' }]);
  });

  it('does not queue anything for a message the client wrote', async () => {
    await owner.query(`INSERT INTO message (thread_id, author_contact_id, author_name, body) VALUES ($1,$2,'Sara','Thanks!')`, [thread, contact]);
    expect(await pending()).toEqual([]);
  });

  it('waits while the conversation is busy, then sends once', async () => {
    await reply('First cut is ready.');
    expect((await sweepClientReplyMail({ send, configured: true })).sent).toBe(0);
    await quiet();
    expect((await sweepClientReplyMail({ send, configured: true })).sent).toBe(1);
    expect(outbox).toEqual([{ to: 'zzz-reply-sara@example.invalid', subject: 'Amin replied to you — VIXART' }]);
    // Sent is sent: the next sweep has nothing.
    expect((await sweepClientReplyMail({ send, configured: true })).sent).toBe(0);
    // And the next reply starts a new email rather than reviving that one.
    await reply('One more thing.');
    expect(await pending()).toHaveLength(1);
  });

  it('sends nothing when the client has already read it in the portal', async () => {
    await reply('First cut is ready.');
    await quiet();
    await portal.query(`SELECT set_config('app.client_contact_id',$1,false)`, [contact]);
    await portal.query(`INSERT INTO client_thread_read (contact_id, thread_id) VALUES ($1,$2)`, [contact, thread]);
    const r = await sweepClientReplyMail({ send, configured: true });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(outbox).toEqual([]);
  });

  it('lets a client change only their own setting', async () => {
    await portal.query(`SELECT set_config('app.client_contact_id',$1,false)`, [contact]);
    expect((await portal.query(`SELECT app.own_reply_emails() AS on`)).rows[0].on).toBe(true);
    await portal.query(`SELECT set_config('app.client_contact_id',$1,false)`, [silent]);
    expect((await portal.query(`SELECT app.own_reply_emails() AS on`)).rows[0].on).toBe(false);
    await portal.query(`SELECT set_config('app.client_contact_id','',false)`);
    await expect(portal.query(`SELECT app.set_own_reply_emails(true)`)).rejects.toThrow(/sign in again/i);
    await expect(portal.query(`SELECT * FROM client_reply_mail`)).rejects.toThrow(/permission denied/i);
  });
});

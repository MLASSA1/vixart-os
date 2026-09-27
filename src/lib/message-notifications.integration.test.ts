import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { composeNotificationMail, EMAILABLE_KINDS } from './notification-mail';

/**
 * A private message, and a client writing in, reach somebody.
 *
 * Neither did. The inbox knew about tasks and mentions; a colleague writing to
 * you directly produced nothing at all, and a client posting in their support
 * conversation fired the live stream, the edit window and a timestamp and told
 * no human being. Amin asked for both, with email.
 *
 * Three properties are worth more than the feature:
 *
 *   1. ONE ROW PER CONVERSATION. Twenty messages must not be twenty inbox
 *      lines, and bumping the row must make it eligible to email again or a
 *      conversation would email once and then go quiet for ever.
 *   2. NEVER THE AUTHOR. Being told about what you just typed is noise, and it
 *      is the mistake that makes people stop reading notifications.
 *   3. NEVER AT THE COST OF THE MESSAGE. A client posting has no app_user, so
 *      the obvious implementation — call app.notify — would have raised inside
 *      their INSERT and lost them what they wrote.
 */

const URL = process.env.DATABASE_URL;
const MARK = 'ZZZ message notify probe';

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('a message notifies somebody (integration)', () => {
  let db: Client;
  let alice = '';
  let bob = '';
  let dm = '';
  let support = '';
  let company = '';
  let contact = '';

  interface Row {
    id: string; kind: string; title: string; body: string | null; link: string;
    emailed_at: string | null; email_attempts: number; read_at: string | null;
  }

  /**
   * One person's notifications FOR ONE THREAD.
   *
   * Scoped to the thread deliberately. The first version asked only by recipient
   * and kind, which passed alone and failed in the full suite: every other test
   * file that writes a direct message or a client message now produces
   * notifications too, for the same seeded people. A test that counts rows
   * belonging to other tests is measuring the order the suite happens to run in.
   */
  const inbox = async (recipient: string, kind: string, thread: string) =>
    (await db.query<Row>(
      `SELECT id, kind, title, body, link, emailed_at::text, email_attempts, read_at::text
         FROM notification
        WHERE recipient_id = $1 AND kind = $2
          AND entity_type = 'thread' AND entity_id = $3
        ORDER BY created_at`, [recipient, kind, thread])).rows;

  /** Writes a message as somebody, the way the application does. */
  async function say(thread: string, authorId: string | null, name: string, body: string) {
    await db.query(`SELECT set_config('app.user_id', $1, false)`, [authorId ?? '']);
    await db.query(`SELECT set_config('app.user_role', $1, false)`, [authorId ? 'member' : '']);
    if (authorId) {
      await db.query(
        `INSERT INTO message (thread_id, author_id, author_name, body) VALUES ($1,$2,$3,$4)`,
        [thread, authorId, name, body]);
    } else {
      await db.query(
        `INSERT INTO message (thread_id, author_contact_id, author_name, body) VALUES ($1,$2,$3,$4)`,
        [thread, contact, name, body]);
    }
  }

  async function purge() {
    await db.query("SET app.bootstrap = 'on'");
    await db.query(`DELETE FROM notification WHERE body LIKE $1 OR title LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM notification WHERE entity_type = 'thread' AND entity_id IN
                     (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await db.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM thread WHERE title LIKE $1 OR (kind='dm' AND title LIKE $1)`, [`${MARK}%`]);
    await db.query(`DELETE FROM client_account WHERE contact_id IN
                     (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await db.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await purge();
    await db.query("SET app.bootstrap = 'on'");

    const people = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 2`)).rows;
    alice = people[0]!.id;
    bob = people[1]!.id;

    dm = (await db.query<{ id: string }>(
      `INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
       VALUES ('dm', $1, $2, $3, $2) RETURNING id`,
      [`${MARK} dm`, alice, bob])).rows[0]!.id;

    company = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship)
       VALUES ($1,'client','client') RETURNING id`, [`${MARK} co`])).rows[0]!.id;
    contact = (await db.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email)
       VALUES ($1,$2,'zzz-notify@example.invalid') RETURNING id`,
      [company, `${MARK} client person`])).rows[0]!.id;
    await db.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',$2)`,
      [contact, alice]);
    support = (await db.query<{ id: string }>(
      `INSERT INTO thread (kind, title, company_id, created_by_id)
       VALUES ('support',$1,$2,$3) RETURNING id`,
      [`${MARK} support`, company, alice])).rows[0]!.id;
  });

  afterAll(async () => {
    if (db) { await purge(); await db.end(); }
  });

  // --- direct messages -------------------------------------------------------

  it('tells the other person, and not the author', async () => {
    await say(dm, alice, 'Alice', `${MARK} are you free`);

    const forBob = await inbox(bob, 'message_received', dm);
    expect(forBob, 'a direct message notified nobody').toHaveLength(1);
    expect(forBob[0]!.body).toContain('are you free');
    expect(forBob[0]!.link).toBe(`/chat/${dm}`);

    const forAlice = await inbox(alice, 'message_received', dm);
    expect(forAlice, 'the author was told about their own message').toHaveLength(0);
  });

  it('keeps one row for the conversation however many messages arrive', async () => {
    await say(dm, alice, 'Alice', `${MARK} still there`);
    await say(dm, alice, 'Alice', `${MARK} third one`);

    const forBob = await inbox(bob, 'message_received', dm);
    expect(forBob, 'a conversation became several inbox rows').toHaveLength(1);
    // Bumped to the newest, not left on the first.
    expect(forBob[0]!.body).toContain('third one');
  });

  it('makes a bumped conversation eligible to email again', async () => {
    /*
     * The trap in deduping: if bumping left `emailed_at` set, a conversation
     * would email once, ever, and every later message would be silent. The gap
     * between emails is the sweep's business, not the row's.
     */
    const [row] = await inbox(bob, 'message_received', dm);
    await db.query(`UPDATE notification SET emailed_at = now(), email_attempts = 1 WHERE id = $1`,
      [row!.id]);

    await say(dm, alice, 'Alice', `${MARK} and another`);

    const [after] = await inbox(bob, 'message_received', dm);
    expect(after!.emailed_at, 'a new message left the row marked as already emailed').toBeNull();
    expect(after!.email_attempts).toBe(0);
  });

  it('starts a fresh row once the old one has been read', async () => {
    await db.query(`UPDATE notification SET read_at = now()
                     WHERE recipient_id = $1 AND kind = 'message_received'
                       AND entity_type = 'thread' AND entity_id = $2`, [bob, dm]);
    await say(dm, alice, 'Alice', `${MARK} after reading`);

    const unread = (await inbox(bob, 'message_received', dm)).filter((r) => r.read_at === null);
    expect(unread, 'a message after reading did not raise a new notification').toHaveLength(1);
  });

  // --- a client writing in ---------------------------------------------------

  it('tells everyone who can answer when a client writes', async () => {
    await say(support, null, `${MARK} client person`, `${MARK} the site is slow`);

    const managers = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role IN ('admin','moderator')
         AND is_active AND is_assignable AND NOT is_service_account`)).rows;
    expect(managers.length).toBeGreaterThan(0);

    for (const m of managers) {
      const rows = await inbox(m.id, 'client_message', support);
      expect(rows, `nobody told ${m.id} that a client wrote`).toHaveLength(1);
      expect(rows[0]!.body).toContain('the site is slow');
    }
  });

  it('does not treat our own reply as news', async () => {
    const before = (await inbox(alice, 'client_message', support))[0]!;
    await say(support, alice, 'Alice', `${MARK} looking into it now`);
    const after = (await inbox(alice, 'client_message', support))[0]!;
    // Same row, same body: our reply changed nothing.
    expect(after.body).toBe(before.body);
  });

  it('never costs the client the message they wrote', async () => {
    /*
     * The reason this is a bespoke function rather than a call to app.notify:
     * that one raises unless a member of staff is signed in, and a client is
     * not one. It would have aborted their INSERT.
     */
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message WHERE thread_id = $1 AND body LIKE $2`,
      [support, `${MARK}%`]);
    expect(Number(rows[0]!.n)).toBe(2);
  });

  // --- the mail itself -------------------------------------------------------

  it('composes a readable email for every kind it claims to send', () => {
    for (const kind of EMAILABLE_KINDS) {
      const mail = composeNotificationMail({
        kind,
        title: 'Roastery edit',
        body: 'Brand film — winter',
        link: '/my-work',
        actor_name: 'Amin',
        full_name: 'Aya Elmoubarki',
      });
      expect(mail.subject.length, kind).toBeGreaterThan(5);
      // Addressed to a person, and carrying a way back in.
      expect(mail.text, kind).toContain('Aya');
      expect(mail.text, kind).toContain('/my-work');
      expect(mail.html, kind).toContain('href=');
      // No markup leaking into the plain part.
      expect(mail.text, kind).not.toContain('<p>');
    }
  });

  it('escapes what somebody else wrote before putting it in html', () => {
    const mail = composeNotificationMail({
      kind: 'message_received',
      title: 'Alice',
      body: '<img src=x onerror="alert(1)">',
      link: '/chat/x',
      actor_name: 'Alice',
      full_name: 'Bob',
    });
    // The tag must not survive as a tag. Escaped text containing the words is
    // exactly right — what matters is that no element is created.
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;img');
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

/**
 * The chat server action, driven end to end.
 *
 * Everything else about chat is asserted in SQL — `chat.integration.test.ts`
 * connects as the application role and proves the policies. That is the right
 * layer for visibility, and none of it noticed that the thread page returned
 * 500 for every user, in production, from the day the feature shipped. The
 * page called a server action during its render; the action revalidated; Next
 * refuses that. The SQL was flawless and the feature was unreachable.
 *
 * So this file runs the actual exported action, against the actual database,
 * through the actual application role, and asserts what the person at the
 * keyboard would see. Two things an HTTP request supplies are replaced and
 * nothing else:
 *
 *   - the session, which is a cookie, not a fact about the code
 *   - `next/cache`, which throws outside a request — and is recorded here, so
 *     the test can assert WHERE revalidation happens and where it must not
 *
 * `getDb()` uses APP_DATABASE_URL, the NOBYPASSRLS role, so the policies are
 * live underneath all of this.
 */

const shared = vi.hoisted(() => ({
  session: {
    user: { id: '', role: 'member' as const, name: '', email: 'probe@vixart.test' },
  },
  revalidated: [] as string[],
}));

vi.mock('@/auth', () => ({
  auth: async () => shared.session,
  requireSession: async () => shared.session,
  requireAdminSession: async () => shared.session,
}));

vi.mock('next/cache', () => ({
  revalidatePath: (p: string) => void shared.revalidated.push(p),
  revalidateTag: (t: string) => void shared.revalidated.push(t),
}));

const { postMessageAction } = await import('@/app/(app)/chat/actions');
const { markThreadRead } = await import('@/lib/chat-read');
const { withUser } = await import('@/db/session');

const URL = process.env.DATABASE_URL;
const MARK = 'ZZZ action probe';

async function reachable(): Promise<boolean> {
  if (!URL || !process.env.APP_DATABASE_URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('chat actions (integration)', () => {
  let owner: Client;
  let alice = { id: '', name: '' };
  let bob = { id: '', name: '' };
  let threadId = '';

  /** Who the action thinks is signed in. */
  function actAs(person: { id: string; name: string }) {
    shared.session.user.id = person.id;
    shared.session.user.name = person.name;
  }

  function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `DELETE FROM notification WHERE entity_type='message' AND entity_id IN
         (SELECT id FROM message WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1))`,
      [`${MARK}%`]);
    await owner.query(
      `DELETE FROM thread_read WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`,
      [`${MARK}%`]);
    await owner.query(
      `DELETE FROM message WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`,
      [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();

    const { rows } = await owner.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM app_user
        WHERE is_active AND is_assignable AND NOT is_service_account
        ORDER BY created_at LIMIT 2`);
    alice = { id: rows[0]!.id, name: rows[0]!.full_name };
    bob = { id: rows[1]!.id, name: rows[1]!.full_name };

    threadId = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, created_by_id) VALUES ('general',$1,$2) RETURNING id`,
      [`${MARK} general`, alice.id])).rows[0]!.id;
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
  });

  // --- sending -------------------------------------------------------------

  it('posts a message and reports plain success', async () => {
    actAs(alice);
    shared.revalidated.length = 0;

    const result = await postMessageAction(threadId, { error: null }, form({ body: 'first' }));

    expect(result.error).toBeNull();
    expect(result.notice ?? null).toBeNull();

    const { rows } = await owner.query<{ body: string; author_name: string }>(
      `SELECT body, author_name FROM message WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [threadId]);
    expect(rows[0]!.body).toBe('first');
    // Taken from the session, not the form: a client cannot post under a name.
    expect(rows[0]!.author_name).toBe(alice.name);
  });

  it('revalidates the thread it posted into', async () => {
    // The positive control for the assertion two tests below. If the mock were
    // not wired up, "nothing was revalidated" would pass for the wrong reason.
    actAs(alice);
    shared.revalidated.length = 0;
    await postMessageAction(threadId, { error: null }, form({ body: 'second' }));
    expect(shared.revalidated).toContain(`/chat/${threadId}`);
  });

  it('refuses an empty message, and says so as an error', async () => {
    actAs(alice);
    const result = await postMessageAction(threadId, { error: null }, form({ body: '   ' }));
    // An error, because nothing happened: the composer must keep what it has.
    expect(result.error).toMatch(/write something/i);
  });

  // --- mentions ------------------------------------------------------------

  it('notifies a colleague who is named and can see the thread', async () => {
    actAs(alice);
    const result = await postMessageAction(
      threadId, { error: null }, form({ body: `@${bob.name} can you look at this` }));

    expect(result.error).toBeNull();
    expect(result.notice ?? null).toBeNull();

    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification
        WHERE recipient_id=$1 AND kind='mentioned' AND link=$2`,
      [bob.id, `/chat/${threadId}`]);
    expect(rows[0]!.n).toBe('1');
  });

  it('sends the message and says so when a mention lands on nobody', async () => {
    actAs(alice);
    const result = await postMessageAction(
      threadId, { error: null }, form({ body: '@Nobody Here please advise' }));

    // THE POINT. This is a success. It used to come back in `error`, and the
    // composer only clears itself on `!error` — so the text stayed in the box,
    // reading as a failure, inviting the author to press Send again and post
    // the same message twice.
    expect(result.error).toBeNull();
    // Reported as `@Nobody`: with nothing to match, the parser keeps the one
    // word it can be sure the author typed rather than guessing at the rest.
    expect(result.notice).toMatch(/@Nobody/);
    expect(result.notice).toMatch(/not notified/i);

    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message WHERE thread_id=$1 AND body LIKE '%Nobody Here%'`,
      [threadId]);
    expect(rows[0]!.n).toBe('1');
  });

  it('does not notify you for naming yourself', async () => {
    actAs(bob);
    await postMessageAction(threadId, { error: null }, form({ body: `@${bob.name} note to self` }));

    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification
        WHERE recipient_id=$1 AND kind='mentioned' AND body LIKE '%note to self%'`, [bob.id]);
    expect(rows[0]!.n).toBe('0');
  });

  // --- reading -------------------------------------------------------------

  it('marks a thread read without revalidating anything', async () => {
    // The regression, stated as behaviour rather than as source. Marking runs
    // during a page render; a revalidate there is what returned 500 on every
    // thread in production.
    actAs(bob);
    shared.revalidated.length = 0;

    await withUser(async (tx, user) => markThreadRead(tx, user.id, threadId));

    expect(shared.revalidated).toEqual([]);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM thread_read WHERE thread_id=$1 AND user_id=$2`,
      [threadId, bob.id]);
    expect(rows[0]!.n).toBe('1');
  });

  it('moves the read mark forward instead of failing on the second look', async () => {
    actAs(bob);
    const first = (await owner.query<{ t: string }>(
      `SELECT last_read_at::text AS t FROM thread_read WHERE thread_id=$1 AND user_id=$2`,
      [threadId, bob.id])).rows[0]!.t;

    await withUser(async (tx, user) => markThreadRead(tx, user.id, threadId));

    const second = (await owner.query<{ t: string }>(
      `SELECT last_read_at::text AS t FROM thread_read WHERE thread_id=$1 AND user_id=$2`,
      [threadId, bob.id])).rows[0]!.t;
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
  });

  it('keeps a read mark to its owner', async () => {
    actAs(alice);
    await withUser(async (tx, user) => markThreadRead(tx, user.id, threadId));

    const { rows } = await owner.query<{ user_id: string }>(
      `SELECT user_id FROM thread_read WHERE thread_id=$1 ORDER BY user_id`, [threadId]);
    // Two marks, one each — never one row quietly overwritten by whoever looked last.
    expect(rows).toHaveLength(2);
  });
});

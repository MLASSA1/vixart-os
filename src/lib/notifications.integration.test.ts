import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Notifications: in-app, addressed to one person, and never about a thing they
 * cannot open.
 *
 * Visibility here is the RECIPIENT, not the parent — which means there is no
 * second line of defence. A notification created for the wrong person is
 * perfectly readable by them.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ notify probe';

describe.skipIf(!HAS_DB)('notifications (integration)', () => {
  let owner: Client;
  let app: Client;
  let alice = '';
  let bob = '';
  let moderator = '';
  let serviceId = '';
  let projectId = '';
  let companyId = '';

  const actAs = async (id: string, role: string) => {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [id]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  };

  async function purge() {
    await owner.query(`DELETE FROM notification WHERE title LIKE $1 OR body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM task WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name = $1`, [MARK]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");
    await purge();

    const members = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='member' AND is_assignable AND is_active
        ORDER BY created_at LIMIT 2`);
    alice = members.rows[0]!.id;
    bob = members.rows[1]!.id;
    moderator = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='moderator' AND is_assignable LIMIT 1`)).rows[0]!.id;
    serviceId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_service_account LIMIT 1`)).rows[0]!.id;

    companyId = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [MARK])).rows[0]!.id;
    projectId = (await owner.query<{ id: string }>(
      `INSERT INTO project (name, company_id, status, project_type)
       VALUES ($1,$2,'active','branding') RETURNING id`, [MARK, companyId])).rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  const inboxOf = async (who: string) => {
    await actAs(who, 'member');
    const { rows } = await app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification WHERE title LIKE $1`, [`${MARK}%`]);
    return Number(rows[0]!.n);
  };

  it('tells someone when work is handed to them', async () => {
    await actAs(moderator, 'moderator');
    await app.query(
      `INSERT INTO task (title, project_id, assignee_id, status, priority)
       VALUES ($1,$2,$3,'todo','normal')`, [`${MARK} edit the film`, projectId, bob]);

    expect(await inboxOf(bob)).toBe(1);
    // And nobody else.
    expect(await inboxOf(alice)).toBe(0);
  });

  it('does not tell you about your own action', async () => {
    await actAs(moderator, 'moderator');
    await app.query(
      `INSERT INTO task (title, project_id, assignee_id, status, priority)
       VALUES ($1,$2,$3,'todo','normal')`, [`${MARK} my own task`, projectId, moderator]);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification
        WHERE recipient_id=$1 AND title=$2`, [moderator, `${MARK} my own task`]);
    expect(rows[0]!.n).toBe('0');
  });

  it('keeps an inbox private to its owner', async () => {
    await actAs(alice, 'member');
    const { rows } = await app.query(
      `SELECT 1 FROM notification WHERE recipient_id=$1`, [bob]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to let anyone write into a colleague\'s inbox', async () => {
    await actAs(alice, 'member');
    await expect(
      app.query(
        `INSERT INTO notification (recipient_id, kind, title, link)
         VALUES ($1,'mentioned',$2,'/chat')`, [bob, `${MARK} forged`]),
    ).rejects.toThrow(/row-level security/i);
  });

  it('raises a sign-off notice for the moderators when work is submitted', async () => {
    const t = (await owner.query<{ id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, status, priority)
       VALUES ($1,$2,$3,'todo','normal') RETURNING id`,
      [`${MARK} needs signoff`, projectId, bob])).rows[0]!.id;

    await actAs(bob, 'member');
    await app.query(`UPDATE task SET status='submitted' WHERE id=$1`, [t]);

    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification
        WHERE kind='task_awaiting_signoff' AND entity_id=$1`, [t]);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('never gives a service account an inbox', async () => {
    await owner.query(
      `SELECT app.notify($1,'mentioned',$2,'/chat')`, [serviceId, `${MARK} to a robot`]);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification WHERE recipient_id=$1`, [serviceId]);
    expect(rows[0]!.n).toBe('0');
  });

  it('raises an overdue notice once, not once a night', async () => {
    const t = (await owner.query<{ id: string }>(
      `INSERT INTO task (title, project_id, assignee_id, status, priority, due_date)
       VALUES ($1,$2,$3,'todo','normal', current_date - 3) RETURNING id`,
      [`${MARK} late thing`, projectId, bob])).rows[0]!.id;

    const first = Number((await owner.query<{ n: string }>(
      `SELECT app.notify_overdue_tasks() AS n`)).rows[0]!.n);
    expect(first).toBeGreaterThan(0);

    // A task overdue for a week is not newly overdue each morning.
    const second = Number((await owner.query<{ n: string }>(
      `SELECT app.notify_overdue_tasks() AS n`)).rows[0]!.n);
    expect(second).toBe(0);

    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification WHERE kind='task_overdue' AND entity_id=$1`, [t]);
    expect(rows[0]!.n).toBe('1');
  });

  it('lets you mark your own read, and only your own', async () => {
    await actAs(bob, 'member');
    await app.query(`UPDATE notification SET read_at = now() WHERE read_at IS NULL`);
    expect(await inboxOf(bob)).toBeGreaterThan(0);   // still there, just read

    await actAs(alice, 'member');
    const r = await app.query(
      `UPDATE notification SET read_at = NULL WHERE recipient_id=$1`, [bob]);
    expect(r.rowCount).toBe(0);
  });

  it('lets nobody delete a notification', async () => {
    await actAs(bob, 'member');
    const r = await app.query(`DELETE FROM notification WHERE title LIKE $1`, [`${MARK}%`]);
    expect(r.rowCount).toBe(0);
  });
});

/**
 * THE ASSUMPTION THIS FEATURE RESTS ON.
 *
 * Read this before deleting the test below.
 */
describe.skipIf(!HAS_DB)('mention safety assumption', () => {
  let owner: Client;
  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");
  });
  afterAll(async () => { await owner?.end(); });

  it('every assignable person can still see every thread', async () => {
    const people = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_user
        WHERE is_active AND is_assignable AND NOT is_service_account`);
    const total = Number(people.rows[0]!.n);

    // Both parents of a thread are visible to any signed-in person today.
    //
    // Policies that apply ONLY to the client portal's role are excluded, and
    // the distinction matters: this test is about whether a MEMBER OF STAFF
    // can still see every thread. A policy `TO vixart_client` can never be
    // evaluated for a staff session — it cannot narrow what staff see, and it
    // cannot widen it either. What must keep firing this test is somebody
    // narrowing `company_select` or `project_select` themselves, which are
    // `{public}` and are checked below exactly as before.
    const parents = await owner.query<{ tablename: string; qual: string }>(
      `SELECT tablename, qual FROM pg_policies
        WHERE tablename IN ('company','project') AND cmd = 'SELECT'
          AND policyname NOT LIKE '%bootstrap%'
          AND NOT (roles = '{vixart_client}')`);

    const narrowed = parents.rows.filter((r) => !/is_authenticated\(\)/.test(r.qual ?? ''));

    expect(
      narrowed.map((r) => `${r.tablename}: ${r.qual}`),
      `
────────────────────────────────────────────────────────────────────────
  THIS IS NOT A BROKEN TEST. DO NOT DELETE IT.
────────────────────────────────────────────────────────────────────────

  Client or project visibility has been NARROWED. Until now every one of
  the ${total} assignable people could see every thread, because company
  and project were both app.is_authenticated(). The @mention check relies
  on that: it asks whether a thread is visible TO THE AUTHOR and treats
  the answer as true for the person being mentioned.

  That is now wrong. Someone can be mentioned into a thread they cannot
  open — and because a notification's RLS is its RECIPIENT and not the
  thing it points at, the notification will be perfectly readable by them
  and the link will 404. There is no second line of defence.

  THE FIX IS OPTION (a), deferred deliberately in Phase 7B:

    Make the visibility rule user-parameterised, stated once and called
    twice — app.user_can_see_company(user, id),
    app.user_can_see_project(user, id), app.user_can_see_thread(user, id).
    Each RLS policy calls its own predicate with app.current_user_id();
    the mention check calls the same predicate with the mentioned
    person's id. One definition, no drift.

    Then have postMessageAction build its candidate list with
    app.user_can_see_thread(<mentioned person>, <thread>) instead of
    relying on the author's own visibility.

  See src/app/(app)/chat/actions.ts — the mention block — and
  drizzle/0042_team_chat.sql for the policy this replaces.
────────────────────────────────────────────────────────────────────────
`,
    ).toEqual([]);
  });
});

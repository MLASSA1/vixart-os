import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * What a client cannot reach.
 *
 * This is the most important test in the project, and it is written as a list
 * of refusals rather than a list of features, because the failure it guards
 * against has no symptom: a client portal that shows a client their own
 * projects looks identical whether or not it ALSO lets them read everybody
 * else's. The screenshots are the same. The pages are the same. The difference
 * only appears when somebody goes looking.
 *
 * Until migration 0064 every account in this system belonged to a member of
 * staff, and seventeen policies say "any authenticated person" because that is
 * what the phrase meant. The boundary is three independent layers:
 *
 *   1. GRANTS — the client role can SELECT from six tables and INSERT into
 *      one. Grants are checked before policies, so nothing else is reachable
 *      whatever any policy says.
 *   2. THE OLD POLICIES evaluate false for a client session, because they rest
 *      on app.is_real_person() / app.is_authenticated(), and a client has no
 *      app_user row and sets no staff role.
 *   3. NEW POLICIES admit only their own company's rows.
 *
 * Every test below runs as the REAL `vixart_client` role over a real
 * connection. Running them as the owner, or as the application role, would
 * prove nothing at all — both can read everything by design.
 */

const URL = process.env.DATABASE_URL;
const CLIENT = process.env.CLIENT_DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ boundary probe';

async function reachable(): Promise<boolean> {
  if (!URL || !CLIENT) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('the client boundary (integration)', () => {
  let owner: Client;
  let portal: Client;

  let mine = { company: '', contact: '', project: '', thread: '', message: '' };
  let theirs = { company: '', contact: '', project: '', thread: '', message: '' };
  let staffId = '';
  let generalThread = '';

  /** Puts the portal connection in the shoes of one client contact. */
  async function asClient(contactId: string | null) {
    await portal.query(
      `SELECT set_config('app.client_contact_id', $1, false)`,
      [contactId ?? ''],
    );
  }

  async function makeClient(name: string) {
    const co = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [`${MARK} ${name}`])).rows[0]!.id;
    const ct = (await owner.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email) VALUES ($1,$2,$3) RETURNING id`,
      [co, `${MARK} ${name} contact`, `zzz-${name}@example.invalid`])).rows[0]!.id;
    await owner.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',$2)`,
      [ct, staffId]);
    const pr = (await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
      [co, `${MARK} ${name} project`])).rows[0]!.id;
    const th = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, company_id, created_by_id)
       VALUES ('support',$1,$2,$3) RETURNING id`,
      [`${MARK} ${name} support`, co, staffId])).rows[0]!.id;
    const ms = (await owner.query<{ id: string }>(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Staff',$3) RETURNING id`,
      [th, staffId, `${MARK} ${name} said`])).rows[0]!.id;
    return { company: co, contact: ct, project: pr, thread: th, message: ms };
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_account WHERE contact_id IN
                        (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
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
    generalThread = (await owner.query<{ id: string }>(
      `SELECT id FROM thread WHERE kind='general' LIMIT 1`)).rows[0]!.id;

    mine = await makeClient('mine');
    theirs = await makeClient('theirs');

    portal = new Client({ connectionString: CLIENT });
    await portal.connect();
  });

  afterAll(async () => {
    if (portal) await portal.end();
    if (owner) { await purge(); await owner.end(); }
  });

  // --- layer 1: the grants ---------------------------------------------------

  it('cannot read the tables it was never granted, whatever any policy says', async () => {
    await asClient(mine.contact);

    // The internal business, one table at a time. A grant is checked BEFORE a
    // policy, so these fail even if somebody later writes a careless policy.
    const forbidden = [
      'app_user', 'task', 'activity', 'document', 'document_line', 'interaction',
      'equipment', 'notification', 'deal', 'retainer', 'prep', 'effort_log',
      'comment', 'attachment', 'schedule_entry', 'private_note', 'client_account',
      'thread_read', 'login_attempt',
    ];

    const reachable: string[] = [];
    for (const table of forbidden) {
      try {
        await portal.query(`SELECT 1 FROM ${table} LIMIT 1`);
        reachable.push(table);
      } catch (error) {
        // Either no grant, or the table does not exist in this schema. Both
        // are refusals; anything else is a hole.
        const message = String(error);
        if (!/permission denied|does not exist/i.test(message)) reachable.push(table);
      }
    }

    expect(
      reachable,
      `\nA client connection can read these tables:\n  ${reachable.join(', ')}\n` +
        `Every one of them is internal. Revoke the grant.\n`,
    ).toEqual([]);
  });

  it('cannot write to anything but its own messages', async () => {
    await asClient(mine.contact);
    await expect(portal.query(
      `UPDATE company SET name = 'taken over' WHERE id = $1`, [mine.company],
    )).rejects.toThrow(/permission denied/i);
    await expect(portal.query(
      `INSERT INTO project (company_id, name, status) VALUES ($1,'sneaky','active')`,
      [mine.company],
    )).rejects.toThrow(/permission denied/i);
    await expect(portal.query(
      `DELETE FROM message WHERE id = $1`, [mine.message],
    )).rejects.toThrow(/permission denied/i);
  });

  // --- layer 2: the old policies do not admit a client -----------------------

  it('is not a real person and is not authenticated staff', async () => {
    await asClient(mine.contact);
    const { rows } = await portal.query<{ real: boolean; auth: boolean; client: boolean }>(
      `SELECT app.is_real_person() AS real, app.is_authenticated() AS auth,
              app.is_client() AS client`,
    );
    // If either of the first two were ever true for a client session, the
    // seventeen policies written for staff would admit them wholesale.
    expect(rows[0]!.real).toBe(false);
    expect(rows[0]!.auth).toBe(false);
    expect(rows[0]!.client).toBe(true);
  });

  // --- layer 3: the new policies are narrow ----------------------------------

  it('sees its own company and no other', async () => {
    await asClient(mine.contact);
    const { rows } = await portal.query<{ id: string }>(`SELECT id FROM company`);
    expect(rows.map((r) => r.id)).toEqual([mine.company]);
  });

  it('sees its own projects and no other client’s', async () => {
    await asClient(mine.contact);
    const { rows } = await portal.query<{ id: string }>(`SELECT id FROM project`);
    expect(rows.map((r) => r.id)).toEqual([mine.project]);
  });

  it('sees its own contact record and not its colleagues’', async () => {
    // A client's colleagues are still people whose details we hold because
    // VIXART was told them, not because the portal should hand them back.
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `INSERT INTO contact (company_id, full_name, email) VALUES ($1,$2,$3)`,
      [mine.company, `${MARK} a colleague`, 'zzz-colleague@example.invalid']);

    await asClient(mine.contact);
    const { rows } = await portal.query<{ id: string }>(`SELECT id FROM contact`);
    expect(rows.map((r) => r.id)).toEqual([mine.contact]);
  });

  it('sees only its own support thread — not General, not a client channel', async () => {
    await asClient(mine.contact);
    const { rows } = await portal.query<{ id: string }>(`SELECT id FROM thread`);
    expect(rows.map((r) => r.id)).toEqual([mine.thread]);
    expect(rows.map((r) => r.id)).not.toContain(generalThread);
    expect(rows.map((r) => r.id)).not.toContain(theirs.thread);
  });

  it('reads only the messages in its own support thread', async () => {
    await asClient(mine.contact);
    const { rows } = await portal.query<{ id: string }>(`SELECT id FROM message`);
    expect(rows.map((r) => r.id)).toEqual([mine.message]);
  });

  it('can write in its own thread, attributed to itself', async () => {
    await asClient(mine.contact);
    await expect(portal.query(
      `INSERT INTO message (thread_id, author_contact_id, author_name, body)
       VALUES ($1,$2,'Client',$3)`,
      [mine.thread, mine.contact, `${MARK} from the client`],
    )).resolves.toBeTruthy();
  });

  it('cannot write into another company’s support thread', async () => {
    await asClient(mine.contact);
    await expect(portal.query(
      `INSERT INTO message (thread_id, author_contact_id, author_name, body)
       VALUES ($1,$2,'Client',$3)`,
      [theirs.thread, mine.contact, `${MARK} trespass`],
    )).rejects.toThrow(/row-level security/i);
  });

  it('cannot write as somebody else', async () => {
    await asClient(mine.contact);

    // As another contact.
    await expect(portal.query(
      `INSERT INTO message (thread_id, author_contact_id, author_name, body)
       VALUES ($1,$2,'Client',$3)`,
      [mine.thread, theirs.contact, `${MARK} impersonation`],
    )).rejects.toThrow(/row-level security/i);

    // As a member of staff. This is the one that would let a client post
    // something into their own thread that looked like it came from VIXART.
    await expect(portal.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'VIXART',$3)`,
      [mine.thread, staffId, `${MARK} forged staff message`],
    )).rejects.toThrow(/row-level security/i);
  });

  it('sees nothing at all with no session set', async () => {
    // A bug that forgets to set the identity must fail closed, not open.
    await asClient(null);
    for (const table of ['company', 'contact', 'project', 'thread', 'message']) {
      const { rows } = await portal.query(`SELECT 1 FROM ${table}`);
      expect(rows, `${table} was readable with no client session`).toHaveLength(0);
    }
  });

  it('sees nothing belonging to a company it names but does not belong to', async () => {
    // Claiming another contact's id is the obvious attack on a session GUC.
    // It is not refused — it IS that contact — which is exactly why the portal
    // only ever sets this from a verified sign-in, and why the company is
    // derived rather than claimed.
    await asClient(theirs.contact);
    const { rows } = await portal.query<{ id: string }>(`SELECT id FROM company`);
    expect(rows.map((r) => r.id)).toEqual([theirs.company]);
  });

  // --- the other side: staff must still see the conversation -----------------

  it.skipIf(!APP)('staff can read and answer a support thread', async () => {
    const app = new Client({ connectionString: APP });
    await app.connect();
    try {
      await app.query(`SELECT set_config('app.user_id',$1,false)`, [staffId]);
      await app.query(`SELECT set_config('app.user_role','moderator',false)`);

      const seen = await app.query<{ id: string }>(
        `SELECT id FROM thread WHERE kind='support'`);
      expect(seen.rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([mine.thread, theirs.thread]),
      );

      await expect(app.query(
        `INSERT INTO message (thread_id, author_id, author_name, body)
         VALUES ($1,$2,'Staff',$3)`,
        [mine.thread, staffId, `${MARK} staff reply`],
      )).resolves.toBeTruthy();
    } finally {
      await app.end();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * What a client is shown of a project (0086) and of their conversation (0087).
 *
 * A delivered file is a project file somebody chose to share — never the rest
 * of the project's files, never another client's. The read marker is the
 * client's own row; what they learn of the team's reading is one timestamp.
 * All of it as the real `vixart_client` role, and sharing as the real
 * application role.
 */

const URL = process.env.DATABASE_URL;
const CLIENT = process.env.CLIENT_DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ delivery probe';

async function reachable(url?: string): Promise<boolean> {
  if (!url) return false;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = (await reachable(URL)) && (await reachable(CLIENT)) && (await reachable(APP));

describe.skipIf(!HAS_DB)('what a client is shown of a project and a conversation (integration)', () => {
  let owner: Client;
  let portal: Client;
  let app: Client;
  let ownerId = '';
  let memberId = '';
  const mine = { company: '', contact: '', project: '', thread: '', shared: '', private: '' };
  const theirs = { company: '', contact: '', project: '', thread: '', shared: '' };

  const path = () => `2026/11/${crypto.randomUUID()}.pdf`;
  const asClient = (id: string) => portal.query(`SELECT set_config('app.client_contact_id', $1, false)`, [id]);
  const asStaff = (id: string, role: string) =>
    app.query(`SELECT set_config('app.user_id',$1,false), set_config('app.user_role',$2,false)`, [id, role]);

  async function client(name: string) {
    const co = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`, [`${MARK} ${name}`])).rows[0]!.id;
    const ct = (await owner.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email) VALUES ($1,$2,$3) RETURNING id`,
      [co, `${MARK} ${name}`, `zzz-delivery-${name}@example.invalid`])).rows[0]!.id;
    await owner.query(
      `INSERT INTO client_account (contact_id, password_hash) VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash')`, [ct]);
    const pr = (await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status, next_step) VALUES ($1,$2,'active','First cut on Thursday') RETURNING id`,
      [co, `${MARK} ${name}`])).rows[0]!.id;
    const th = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, company_id, created_by_id) VALUES ('support',$1,$2,$3) RETURNING id`, [`${MARK} ${name}`, co, ownerId])).rows[0]!.id;
    const file = async (shared: boolean) => (await owner.query<{ id: string }>(
      `INSERT INTO attachment (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, shared_with_client, shared_at)
       VALUES ('project',$1,$2,$3,'application/pdf',100,$4, CASE WHEN $4 THEN now() END) RETURNING id`,
      [pr, `${MARK} ${shared ? 'final' : 'rough'}.pdf`, path(), shared])).rows[0]!.id;
    return { company: co, contact: ct, project: pr, thread: th, shared: await file(true), private: await file(false) };
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM attachment WHERE original_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_thread_read WHERE contact_id IN (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread_read WHERE thread_id IN (SELECT id FROM thread WHERE title LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_account WHERE contact_id IN (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    ownerId = (await owner.query<{ id: string }>(`SELECT id FROM app_user WHERE is_owner`)).rows[0]!.id;
    memberId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='member' AND is_active LIMIT 1`)).rows[0]?.id ?? ownerId;
    Object.assign(mine, await client('mine'));
    const t = await client('theirs');
    Object.assign(theirs, { company: t.company, contact: t.contact, project: t.project, thread: t.thread, shared: t.shared });

    portal = new Client({ connectionString: CLIENT });
    await portal.connect();
    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (portal) await portal.end();
    if (app) await app.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('sees the files shared on its own project, and no other file', async () => {
    await asClient(mine.contact);
    const r = await portal.query<{ id: string }>(`SELECT id FROM attachment WHERE entity_type='project'`);
    expect(r.rows.map((x) => x.id)).toEqual([mine.shared]);
  });

  it('reads the next step written for it', async () => {
    await asClient(mine.contact);
    const r = await portal.query<{ next_step: string }>(`SELECT next_step FROM project WHERE id=$1`, [mine.project]);
    expect(r.rows[0]?.next_step).toBe('First cut on Thursday');
  });

  it('cannot share a file: only a producer or an administrator can', async () => {
    await expect(portal.query(`SELECT app.share_with_client($1, true)`, [mine.private])).rejects.toThrow(/permission denied/i);
    if (memberId !== ownerId) {
      await asStaff(memberId, 'member');
      await expect(app.query(`SELECT app.share_with_client($1, true)`, [mine.private])).rejects.toThrow(/only a producer/i);
    }
    await asStaff(ownerId, 'admin');
    await app.query(`SELECT app.share_with_client($1, true)`, [mine.private]);
    await asClient(mine.contact);
    expect((await portal.query(`SELECT id FROM attachment WHERE id=$1`, [mine.private])).rowCount).toBe(1);
    await asStaff(ownerId, 'admin');
    await app.query(`SELECT app.share_with_client($1, false)`, [mine.private]);
    await asClient(mine.contact);
    expect((await portal.query(`SELECT id FROM attachment WHERE id=$1`, [mine.private])).rowCount).toBe(0);
  });

  it('refuses sharing anything that is not a project file', async () => {
    await expect(owner.query(
      `INSERT INTO attachment (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, shared_with_client, shared_at)
       VALUES ('company',$1,$2,$3,'application/pdf',100,true,now())`, [mine.company, `${MARK} wrong.pdf`, path()],
    )).rejects.toThrow(/attachment_shared_only_from_a_project/);
  });

  it('marks its own conversation read, and nobody else\'s', async () => {
    await asClient(mine.contact);
    await portal.query(`INSERT INTO client_thread_read (contact_id, thread_id) VALUES ($1,$2)`, [mine.contact, mine.thread]);
    await expect(portal.query(
      `INSERT INTO client_thread_read (contact_id, thread_id) VALUES ($1,$2)`, [mine.contact, theirs.thread],
    )).rejects.toThrow(/row-level security/i);
    await expect(portal.query(
      `INSERT INTO client_thread_read (contact_id, thread_id) VALUES ($1,$2)`, [theirs.contact, theirs.thread],
    )).rejects.toThrow(/row-level security/i);
    await asClient(theirs.contact);
    expect((await portal.query(`SELECT 1 FROM client_thread_read`)).rowCount).toBe(0);
  });

  it('learns when the team last opened its own conversation, and nothing about another', async () => {
    await owner.query(`INSERT INTO thread_read (thread_id, user_id, last_read_at) VALUES ($1,$2,'2026-11-09T10:00:00Z')`, [theirs.thread, ownerId]);
    await asClient(mine.contact);
    expect((await portal.query(`SELECT app.support_seen_by_team_at() AS at`)).rows[0].at).toBeNull();
    await asClient(theirs.contact);
    expect((await portal.query(`SELECT app.support_seen_by_team_at()::text AS at`)).rows[0].at).toMatch(/^2026-11-09/);
    await expect(portal.query(`SELECT 1 FROM thread_read`)).rejects.toThrow(/permission denied/i);
  });
});

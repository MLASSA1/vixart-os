import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Channels that open themselves.
 *
 * Chat had a "Start the thread" form and nothing else, so a conversation about
 * a project required somebody to remember to make a place for it. Nobody ever
 * did — the table held zero rows for the whole life of the feature. 0046 moves
 * that from a habit to a trigger.
 *
 * Every assertion that could be made through the application role is, because
 * the owner holds BYPASSRLS and would pass regardless of the policies. The
 * point of doing the insert from a trigger rather than from the server action
 * is that it happens whatever created the record — so it has to work under the
 * creator's own policies, not around them.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ channel probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('default channels (integration)', () => {
  let owner: Client;
  let app: Client;
  let adminId = '';

  async function actAs(userId: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [userId]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    // Threads cascade from their parent, so the parents are enough — except a
    // stray general one, which has no parent to take it.
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    adminId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' AND is_active ORDER BY created_at LIMIT 1`)
    ).rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  // --- General -------------------------------------------------------------

  it('has exactly one General, put there by the migration', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM thread WHERE kind='general' AND is_default`);
    expect(rows[0]!.n).toBe('1');
  });

  it('will not accept a second default General', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await expect(
      owner.query(
        `INSERT INTO thread (kind, title, created_by_id, is_default)
         VALUES ('general',$1,$2,true)`, [`${MARK} second general`, adminId]),
    ).rejects.toThrow(/thread_one_general/);
  });

  it('lets everyone read General, including a plain member', async () => {
    const { rows: members } = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='member' AND is_active AND is_assignable
         AND NOT is_service_account LIMIT 1`);
    await actAs(members[0]!.id, 'member');
    const { rows } = await app.query(
      `SELECT 1 FROM thread WHERE kind='general' AND is_default`);
    expect(rows).toHaveLength(1);
  });

  // --- projects ------------------------------------------------------------

  it('opens a channel when a project is created, named after it', async () => {
    await actAs(adminId, 'admin');
    const companyId = (await app.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [`${MARK} co`])).rows[0]!.id;

    const projectId = (await app.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'planned') RETURNING id`,
      [companyId, `${MARK} film`])).rows[0]!.id;

    const { rows } = await app.query<{ title: string; created_by_id: string; is_default: boolean }>(
      `SELECT title, created_by_id, is_default FROM thread WHERE project_id=$1`, [projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe(`${MARK} film`);
    expect(rows[0]!.is_default).toBe(true);
    // Written as the person who created the project, under thread_insert's own
    // WITH CHECK. Nothing here is a SECURITY DEFINER stepping around a policy.
    expect(rows[0]!.created_by_id).toBe(adminId);
  });

  it('follows a rename, while the channel still carries the name it was given', async () => {
    await actAs(adminId, 'admin');
    const { rows: p } = await app.query<{ id: string }>(
      `SELECT id FROM project WHERE name = $1`, [`${MARK} film`]);
    await app.query(`UPDATE project SET name=$1 WHERE id=$2`, [`${MARK} film v2`, p[0]!.id]);

    const { rows } = await app.query<{ title: string }>(
      `SELECT title FROM thread WHERE project_id=$1`, [p[0]!.id]);
    expect(rows[0]!.title).toBe(`${MARK} film v2`);
  });

  it('leaves a channel alone once somebody has titled it themselves', async () => {
    await actAs(adminId, 'admin');
    const { rows: p } = await app.query<{ id: string }>(
      `SELECT id FROM project WHERE name = $1`, [`${MARK} film v2`]);
    await app.query(`UPDATE thread SET title=$1 WHERE project_id=$2`,
      [`${MARK} edit room`, p[0]!.id]);
    await app.query(`UPDATE project SET name=$1 WHERE id=$2`, [`${MARK} film v3`, p[0]!.id]);

    const { rows } = await app.query<{ title: string }>(
      `SELECT title FROM thread WHERE project_id=$1`, [p[0]!.id]);
    expect(rows[0]!.title).toBe(`${MARK} edit room`);
  });

  it('takes the channel with the project when it goes', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    const { rows: p } = await owner.query<{ id: string }>(
      `SELECT id FROM project WHERE name = $1`, [`${MARK} film v3`]);
    await owner.query(`DELETE FROM project WHERE id=$1`, [p[0]!.id]);
    const { rows } = await owner.query(`SELECT 1 FROM thread WHERE project_id=$1`, [p[0]!.id]);
    expect(rows).toHaveLength(0);
  });

  // --- clients -------------------------------------------------------------

  it('opens a channel for a company created as a client', async () => {
    await actAs(adminId, 'admin');
    const id = (await app.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [`${MARK} straight to client`])).rows[0]!.id;

    const { rows } = await app.query<{ title: string }>(
      `SELECT title FROM thread WHERE company_id=$1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe(`${MARK} straight to client`);
  });

  it('opens none for a lead or a prospect', async () => {
    await actAs(adminId, 'admin');
    for (const status of ['lead', 'prospect']) {
      const id = (await app.query<{ id: string }>(
        `INSERT INTO company (name, status, relationship) VALUES ($1,$2,'client') RETURNING id`,
        [`${MARK} ${status}`, status])).rows[0]!.id;
      const { rows } = await app.query(`SELECT 1 FROM thread WHERE company_id=$1`, [id]);
      expect(rows, `a ${status} should not get a channel`).toHaveLength(0);
    }
  });

  it('opens one the moment a prospect becomes a client', async () => {
    await actAs(adminId, 'admin');
    const { rows: c } = await app.query<{ id: string }>(
      `SELECT id FROM company WHERE name = $1`, [`${MARK} prospect`]);
    await app.query(`UPDATE company SET status='client' WHERE id=$1`, [c[0]!.id]);

    const { rows } = await app.query<{ title: string }>(
      `SELECT title FROM thread WHERE company_id=$1`, [c[0]!.id]);
    expect(rows).toHaveLength(1);
  });

  it('does not open a second one when the status is set again', async () => {
    await actAs(adminId, 'admin');
    const { rows: c } = await app.query<{ id: string }>(
      `SELECT id FROM company WHERE name = $1`, [`${MARK} prospect`]);
    await app.query(`UPDATE company SET status='dormant' WHERE id=$1`, [c[0]!.id]);
    await app.query(`UPDATE company SET status='client' WHERE id=$1`, [c[0]!.id]);

    const { rows } = await app.query(`SELECT 1 FROM thread WHERE company_id=$1`, [c[0]!.id]);
    expect(rows).toHaveLength(1);
  });

  it('leaves a channel standing when a client goes dormant', async () => {
    // The conversation is a record. Losing it because the relationship cooled
    // would be the same mistake as deleting a message.
    await actAs(adminId, 'admin');
    const { rows: c } = await app.query<{ id: string }>(
      `SELECT id FROM company WHERE name = $1`, [`${MARK} prospect`]);
    await app.query(`UPDATE company SET status='dormant' WHERE id=$1`, [c[0]!.id]);
    const { rows } = await app.query(`SELECT 1 FROM thread WHERE company_id=$1`, [c[0]!.id]);
    expect(rows).toHaveLength(1);
  });

  // --- the backfill --------------------------------------------------------

  it('gave every existing client and project exactly one channel', async () => {
    const { rows } = await owner.query<{ missing: string; extra: string }>(`
      SELECT
        (SELECT count(*)::text FROM company c
          WHERE c.status='client'
            AND NOT EXISTS (SELECT 1 FROM thread t WHERE t.company_id=c.id AND t.is_default))
          AS missing,
        (SELECT count(*)::text FROM project p
          WHERE NOT EXISTS (SELECT 1 FROM thread t WHERE t.project_id=p.id AND t.is_default))
          AS extra
    `);
    expect(rows[0]!.missing).toBe('0');
    expect(rows[0]!.extra).toBe('0');
  });

  it('is safe to run the backfill again', async () => {
    // Idempotence is the property that lets this migration be re-run against a
    // database that has already had it — which is what a restore from backup
    // followed by a migrate actually does.
    await owner.query("SET app.bootstrap = 'on'");
    const before = (await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM thread`)).rows[0]!.n;

    await owner.query(`
      INSERT INTO thread (kind, title, company_id, created_by_id, is_default)
      SELECT 'company', c.name, c.id, app.channel_author(), true
        FROM company c WHERE c.status='client'
      ON CONFLICT DO NOTHING`);
    await owner.query(`
      INSERT INTO thread (kind, title, project_id, created_by_id, is_default)
      SELECT 'project', p.name, p.id, app.channel_author(), true
        FROM project p
      ON CONFLICT DO NOTHING`);

    const after = (await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM thread`)).rows[0]!.n;
    expect(after).toBe(before);
  });
});

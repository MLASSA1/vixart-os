import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Work goes to people (0062).
 *
 * Le Chef and Le Comptable are automation accounts. Nobody signs in as one,
 * so a task assigned there is not late — it is gone: no inbox to show it, no
 * session to act on it, and the twenty-four-hour nudge mails nobody.
 *
 * The Tasks page offered them in its assign-to list for as long as that page
 * has existed, because the rule lived in a WHERE clause that three pages wrote
 * out by hand and two of them wrote wrong. So the rule moved into the view,
 * and the refusal into the database — a list only decides what is OFFERED,
 * and the id the browser sends is whatever was in the form.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ assignable probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('who can be given work (integration)', () => {
  let owner: Client;
  let app: Client;
  let person = '';
  let robot = '';

  async function actAs(id: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [id]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM task WHERE title LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();

    person = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 1`)).rows[0]!.id;
    robot = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_service_account LIMIT 1`)).rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  it('the directory says who is a person', async () => {
    await actAs(person, 'member');
    const { rows } = await app.query<{ id: string; is_person: boolean }>(
      `SELECT id, is_person FROM app.team_directory WHERE id = ANY($1)`, [[person, robot]]);

    expect(rows.find((r) => r.id === person)?.is_person).toBe(true);
    expect(rows.find((r) => r.id === robot)?.is_person).toBe(false);
  });

  it('refuses a task assigned to a service account', async () => {
    await actAs(person, 'member');
    await expect(app.query(
      `INSERT INTO task (title, assignee_id, priority) VALUES ($1,$2,'normal')`,
      [`${MARK} for a robot`, robot],
    )).rejects.toThrow(/cannot be given work/i);
  });

  it('refuses one reassigned to a service account afterwards', async () => {
    // The insert is not the only door. A task raised correctly and then handed
    // over is the same loss, arrived at one step later.
    await actAs(person, 'member');
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO task (title, assignee_id, priority) VALUES ($1,$2,'normal') RETURNING id`,
      [`${MARK} reassigned`, person]);

    await expect(app.query(
      `UPDATE task SET assignee_id=$2 WHERE id=$1`, [rows[0]!.id, robot],
    )).rejects.toThrow(/cannot be given work/i);
  });

  it('still allows a real person, and allows nobody at all', async () => {
    await actAs(person, 'member');
    // Unassigned is ordinary: a task raised before anybody picks it up.
    await expect(app.query(
      `INSERT INTO task (title, assignee_id, priority) VALUES ($1,NULL,'normal')`,
      [`${MARK} unassigned`],
    )).resolves.toBeTruthy();

    await expect(app.query(
      `INSERT INTO task (title, assignee_id, priority) VALUES ($1,$2,'normal')`,
      [`${MARK} for a person`, person],
    )).resolves.toBeTruthy();
  });

  it('refuses a deactivated account too', async () => {
    // Deactivating somebody who has left should not leave a door by which
    // work can still be filed against them.
    await owner.query("SET app.bootstrap = 'on'");
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO app_user (email, full_name, role, password_hash, is_active, is_assignable)
       VALUES ($1,$2,'member','NO-LOGIN-probe',false,true) RETURNING id`,
      [`zzz-assignable-probe@example.invalid`, `${MARK} departed`]);
    const gone = rows[0]!.id;

    try {
      await actAs(person, 'member');
      await expect(app.query(
        `INSERT INTO task (title, assignee_id, priority) VALUES ($1,$2,'normal')`,
        [`${MARK} for someone gone`, gone],
      )).rejects.toThrow(/cannot be given work/i);
    } finally {
      await owner.query("SET app.bootstrap = 'on'");
      await owner.query(`DELETE FROM task WHERE assignee_id=$1`, [gone]);
      await owner.query(`DELETE FROM app_user WHERE id=$1`, [gone]);
    }
  });
});

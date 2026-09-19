import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * A person's own week, and their own notebook (0058).
 *
 * The whole value of both tables is that they are private, so that is what
 * these test — through the APPLICATION role, because the owner holds
 * BYPASSRLS and would read everything regardless of any policy.
 *
 * The note case is the sharper one: it must be refused to an ADMINISTRATOR.
 * Somewhere to draft a thought before it is ready to be said out loud is worth
 * nothing if the person who runs the agency can read the drafts.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ 9G probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('schedule and private notes (integration)', () => {
  let owner: Client;
  let app: Client;
  let mine = '';
  let other = '';
  let boss = '';

  async function actAs(id: string, role: string) {
    await app.query(`SELECT set_config('app.user_id',$1,false)`, [id]);
    await app.query(`SELECT set_config('app.user_role',$1,false)`, [role]);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM schedule_entry WHERE title LIKE $1`, [`${MARK}%`]);
    // private_note has no bootstrap policy by design, so the owner's
    // BYPASSRLS is what makes cleanup possible at all.
    await owner.query(`DELETE FROM private_note WHERE title LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();

    const people = await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='member' AND is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 2`);
    mine = people.rows[0]!.id;
    other = people.rows[1]!.id;
    boss = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' AND is_active LIMIT 1`)).rows[0]!.id;

    app = new Client({ connectionString: APP });
    await app.connect();
  });

  afterAll(async () => {
    if (owner) { await purge(); await owner.end(); }
    if (app) await app.end();
  });

  // --- schedule ------------------------------------------------------------

  it('keeps a personal entry to its owner', async () => {
    await actAs(mine, 'member');
    await app.query(
      `INSERT INTO schedule_entry (user_id, title, kind, starts_on)
       VALUES ($1,$2,'off','2026-09-24')`, [mine, `${MARK} day off`]);

    expect((await app.query(`SELECT 1 FROM schedule_entry WHERE title LIKE $1`,
      [`${MARK}%`])).rows).toHaveLength(1);

    // A colleague cannot see that you booked a day off.
    await actAs(other, 'member');
    expect((await app.query(`SELECT 1 FROM schedule_entry WHERE title LIKE $1`,
      [`${MARK}%`])).rows).toHaveLength(0);

    // Nor can an administrator.
    await actAs(boss, 'admin');
    expect((await app.query(`SELECT 1 FROM schedule_entry WHERE title LIKE $1`,
      [`${MARK}%`])).rows).toHaveLength(0);
  });

  it("refuses putting something in somebody else's week", async () => {
    await actAs(other, 'member');
    await expect(
      app.query(`INSERT INTO schedule_entry (user_id, title, kind, starts_on)
                 VALUES ($1,$2,'meeting','2026-09-24')`, [mine, `${MARK} forced meeting`]),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an end before its start', async () => {
    await actAs(mine, 'member');
    await expect(
      app.query(`INSERT INTO schedule_entry (user_id, title, kind, starts_on, ends_on)
                 VALUES ($1,$2,'shoot','2026-09-24','2026-09-20')`, [mine, `${MARK} backwards`]),
    ).rejects.toThrow(/schedule_range_ordered/);
  });

  // --- private notes -------------------------------------------------------

  it('keeps a private note from everyone, including an administrator', async () => {
    await actAs(mine, 'member');
    await app.query(`INSERT INTO private_note (author_id, title, body)
                     VALUES ($1,$2,$3)`,
      [mine, `${MARK} script idea`, 'Not ready to say this out loud yet']);

    expect((await app.query(`SELECT 1 FROM private_note WHERE title LIKE $1`,
      [`${MARK}%`])).rows).toHaveLength(1);

    await actAs(other, 'member');
    expect((await app.query(`SELECT 1 FROM private_note WHERE title LIKE $1`,
      [`${MARK}%`])).rows).toHaveLength(0);

    // The one that matters.
    await actAs(boss, 'admin');
    expect((await app.query(`SELECT 1 FROM private_note WHERE title LIKE $1`,
      [`${MARK}%`])).rows).toHaveLength(0);
  });

  it('refuses an administrator editing or deleting one', async () => {
    await actAs(mine, 'member');
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO private_note (author_id, title) VALUES ($1,$2) RETURNING id`,
      [mine, `${MARK} untouchable`]);

    await actAs(boss, 'admin');
    expect((await app.query(`UPDATE private_note SET body='read by the boss' WHERE id=$1`,
      [rows[0]!.id])).rowCount).toBe(0);
    expect((await app.query(`DELETE FROM private_note WHERE id=$1`,
      [rows[0]!.id])).rowCount).toBe(0);

    await actAs(mine, 'member');
    const { rows: after } = await app.query<{ body: string }>(
      `SELECT body FROM private_note WHERE id=$1`, [rows[0]!.id]);
    expect(after[0]!.body).toBe('');
  });

  it('has no bootstrap door on private notes', async () => {
    // Every other table has one so seeds and maintenance can reach it. This
    // one deliberately does not: the door would be the single way somebody's
    // unfinished thoughts could be read by a script.
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies
        WHERE tablename='private_note' AND policyname LIKE '%bootstrap%'`);
    expect(rows[0]!.n).toBe('0');
  });
});

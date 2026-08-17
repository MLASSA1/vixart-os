import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Team management guards, asserted on data.
 *
 * The one that matters: the agency must not be able to lock itself out. Losing
 * the last administrator means losing Finance, invoicing and account management
 * with no route back through the interface.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const HAS_DB = await reachable();
const PROBE = 'zzz.probe@vixart.test';

describe.skipIf(!HAS_DB)('team management (integration)', () => {
  let db: Client;
  let aminId: string;

  /** Acts as an admin who is NOT the row being changed. */
  async function asOtherAdmin() {
    await db.query("SELECT set_config('app.user_role','admin',false)");
    await db.query(
      "SELECT set_config('app.user_id','00000000-0000-0000-0000-0000000000aa',false)",
    );
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE email = 'amin@vixart.ma'`,
    );
    aminId = rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("SET app.bootstrap = 'on'");
    await db.query('DELETE FROM app_user WHERE email = $1', [PROBE]);
    await db.end();
  });

  it('refuses to demote, deactivate or delete the last administrator', async () => {
    await asOtherAdmin();
    const before = await db.query<{ role: string; is_active: boolean }>(
      'SELECT role, is_active FROM app_user WHERE id = $1',
      [aminId],
    );

    for (const statement of [
      `UPDATE app_user SET role = 'member' WHERE id = $1`,
      `UPDATE app_user SET is_active = false WHERE id = $1`,
      `DELETE FROM app_user WHERE id = $1`,
    ]) {
      await db.query(statement, [aminId]).catch(() => undefined);
    }

    const after = await db.query<{ role: string; is_active: boolean }>(
      'SELECT role, is_active FROM app_user WHERE id = $1',
      [aminId],
    );
    // The account is untouched, whichever layer refused it.
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]!.role).toBe('admin');
    expect(after.rows[0]!.is_active).toBe(true);
  });

  it('allows the demotion once a second administrator exists', async () => {
    await db.query("SET app.bootstrap = 'on'");
    await db.query(
      `INSERT INTO app_user (email, full_name, role, password_hash, is_active)
       VALUES ($1, 'Probe Admin', 'admin', '$2b$12$0000000000000000000000000000000000000000000000000000', true)`,
      [PROBE],
    );
    await db.query('RESET app.bootstrap');
    await asOtherAdmin();

    // Now Amin is no longer the only one, so the guard should stand aside.
    await db.query(`UPDATE app_user SET role = 'moderator' WHERE id = $1`, [aminId]);
    const demoted = await db.query<{ role: string }>(
      'SELECT role FROM app_user WHERE id = $1',
      [aminId],
    );
    expect(demoted.rows[0]!.role).toBe('moderator');

    // Put it back the way it was — this is the founder's real account.
    await db.query(`UPDATE app_user SET role = 'admin' WHERE id = $1`, [aminId]);
    const restored = await db.query<{ role: string }>(
      'SELECT role FROM app_user WHERE id = $1',
      [aminId],
    );
    expect(restored.rows[0]!.role).toBe('admin');

    await db.query("SET app.bootstrap = 'on'");
    await db.query('DELETE FROM app_user WHERE email = $1', [PROBE]);
    await db.query('RESET app.bootstrap');
  });

  it('refuses a self role change, even for an administrator', async () => {
    await db.query("SELECT set_config('app.user_role','admin',false)");
    await db.query("SELECT set_config('app.user_id',$1,false)", [aminId]);

    await db
      .query(`UPDATE app_user SET role = 'member' WHERE id = $1`, [aminId])
      .catch(() => undefined);

    const { rows } = await db.query<{ role: string }>(
      'SELECT role FROM app_user WHERE id = $1',
      [aminId],
    );
    expect(rows[0]!.role).toBe('admin');
  });

  it('refuses a member promoting themselves', async () => {
    const { rows: members } = await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'member' LIMIT 1`,
    );
    const memberId = members[0]!.id;

    await db.query("SELECT set_config('app.user_role','member',false)");
    await db.query("SELECT set_config('app.user_id',$1,false)", [memberId]);

    await db
      .query(`UPDATE app_user SET role = 'admin' WHERE id = $1`, [memberId])
      .catch(() => undefined);

    const { rows } = await db.query<{ role: string }>(
      'SELECT role FROM app_user WHERE id = $1',
      [memberId],
    );
    expect(rows[0]!.role).toBe('member');
  });

  it('refuses account creation by anyone but an administrator', async () => {
    await db.query("SELECT set_config('app.user_role','moderator',false)");
    await expect(
      db.query(
        `SELECT app.create_team_member($1,'Probe',null,'member',
          '$2b$12$0000000000000000000000000000000000000000000000000000')`,
        [PROBE],
      ),
    ).rejects.toThrow(/only an administrator/i);

    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app_user WHERE email = $1',
      [PROBE],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('creates an account that must change its password', async () => {
    await asOtherAdmin();
    await db.query(
      `SELECT app.create_team_member($1,'Probe Person','Tester','member',
        '$2b$12$0000000000000000000000000000000000000000000000000000')`,
      [PROBE],
    );
    const { rows } = await db.query<{ must_change_password: boolean; role: string }>(
      'SELECT must_change_password, role FROM app_user WHERE email = $1',
      [PROBE],
    );
    expect(rows[0]!.must_change_password).toBe(true);
    expect(rows[0]!.role).toBe('member');
  });
});

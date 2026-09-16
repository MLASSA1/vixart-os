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
/** Not a real bcrypt hash. Nothing here ever signs in. */
const HASH = '$2b$12$0000000000000000000000000000000000000000000000000000';

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

  /**
   * Runs `work` inside a transaction that is ALWAYS rolled back.
   *
   * Everything below changes roles and account access, and it used to do that
   * to the real team — `amin@vixart.ma`, the founder's own login. That was
   * safe only while the database held exactly one administrator, which is an
   * assumption about the DATA, not about the code under test.
   *
   * The day a second admin exists — which is something Amin is actively trying
   * to arrange — the lockout guard correctly stands aside, these UPDATE
   * statements go through, and `npm test` demotes the founder and switches his
   * account off. That happened, on this machine, the first time the whole suite
   * actually ran. A test for a lockout guard must not be able to cause one.
   *
   * Inside a rolled-back transaction the trigger still fires and still raises,
   * so it proves exactly what it proved before — and nothing survives.
   */
  async function inRollback(work: () => Promise<void>) {
    await db.query('BEGIN');
    try {
      await work();
    } finally {
      await db.query('ROLLBACK');
      await db.query('RESET app.bootstrap');
    }
  }

  it('refuses to demote, deactivate or delete the last administrator', async () => {
    await inRollback(async () => {
      // Manufacture the premise instead of hoping for it: exactly one active
      // administrator, and it is a throwaway rather than anybody real.
      await db.query("SET app.bootstrap = 'on'");
      const probe = (
        await db.query<{ id: string }>(
          `INSERT INTO app_user (email, full_name, role, password_hash, is_active)
           VALUES ($1,'Probe Admin','admin',$2,true) RETURNING id`,
          [PROBE, HASH],
        )
      ).rows[0]!.id;
      await db.query(`UPDATE app_user SET role='moderator' WHERE role='admin' AND id <> $1`, [
        probe,
      ]);
      await db.query('RESET app.bootstrap');
      await asOtherAdmin();

      const premise = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app_user WHERE role='admin' AND is_active`,
      );
      expect(premise.rows[0]!.n).toBe('1');

      for (const statement of [
        `UPDATE app_user SET role = 'member' WHERE id = $1`,
        `UPDATE app_user SET is_active = false WHERE id = $1`,
        `DELETE FROM app_user WHERE id = $1`,
      ]) {
        await db.query('SAVEPOINT attempt');
        // Rejected, not quietly ignored. The old version compared the row
        // before and after, which also passes when a statement matches nothing
        // — so it could not tell a working guard from a typo in its WHERE.
        await expect(db.query(statement, [probe])).rejects.toThrow(
          /only active administrator/i,
        );
        await db.query('ROLLBACK TO SAVEPOINT attempt');
      }
    });
  });

  it('allows the demotion once a second administrator exists', async () => {
    await inRollback(async () => {
      await db.query("SET app.bootstrap = 'on'");
      await db.query(
        `INSERT INTO app_user (email, full_name, role, password_hash, is_active)
         VALUES ($1,'Probe Admin','admin',$2,true)`,
        [PROBE, HASH],
      );
      await db.query('RESET app.bootstrap');
      await asOtherAdmin();

      // Amin is no longer the only one, so the guard stands aside.
      await db.query(`UPDATE app_user SET role='moderator' WHERE id = $1`, [aminId]);
      const demoted = await db.query<{ role: string }>(
        'SELECT role FROM app_user WHERE id = $1',
        [aminId],
      );
      expect(demoted.rows[0]!.role).toBe('moderator');
    });

    // And afterwards the founder is exactly as he was. Asserted, because the
    // whole point of the rewrite is that this can no longer be taken on trust.
    const after = await db.query<{ role: string; is_active: boolean }>(
      'SELECT role, is_active FROM app_user WHERE id = $1',
      [aminId],
    );
    expect(after.rows[0]!.role).toBe('admin');
    expect(after.rows[0]!.is_active).toBe(true);
  });

  it('refuses a self role change, even for an administrator', async () => {
    await inRollback(async () => {
      await db.query("SELECT set_config('app.user_role','admin',false)");
      await db.query("SELECT set_config('app.user_id',$1,false)", [aminId]);

      await expect(
        db.query(`UPDATE app_user SET role = 'member' WHERE id = $1`, [aminId]),
      ).rejects.toThrow(/your own role/i);
    });
  });

  it('refuses a member promoting themselves', async () => {
    await inRollback(async () => {
      const { rows: members } = await db.query<{ id: string }>(
        `SELECT id FROM app_user WHERE role = 'member' LIMIT 1`,
      );
      const memberId = members[0]!.id;

      await db.query("SELECT set_config('app.user_role','member',false)");
      await db.query("SELECT set_config('app.user_id',$1,false)", [memberId]);

      await expect(
        db.query(`UPDATE app_user SET role = 'admin' WHERE id = $1`, [memberId]),
      ).rejects.toThrow(/your own role/i);
    });
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

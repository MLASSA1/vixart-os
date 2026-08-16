import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The immutability guards, asserted on DATA rather than on exceptions.
 *
 * Written this way on purpose. Twice during development a check of the form
 * "expect this UPDATE to throw" reported a false alarm, because row level
 * security filtered the statement to zero rows and the trigger was never
 * reached — nothing threw, and nothing changed either. Asserting that the value
 * is unchanged is the property that actually matters, and it holds whichever
 * layer does the stopping.
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

describe.skipIf(!HAS_DB)('immutability guards (integration)', () => {
  let session: Client;

  beforeAll(async () => {
    // A signed-in admin — the most privileged session the application ever has.
    session = new Client({ connectionString: URL });
    await session.connect();
    const { rows } = await session.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'admin' LIMIT 1`,
    );
    await session.query("SELECT set_config('app.user_role','admin',false)");
    await session.query("SELECT set_config('app.user_id',$1,false)", [rows[0]!.id]);
  });

  afterAll(async () => {
    if (session) await session.end();
  });

  it('an admin cannot rewrite a tax rate', async () => {
    const before = await session.query<{ key: string; rate_bp: number }>(
      'SELECT key, rate_bp FROM fiscal_rate ORDER BY key',
    );
    await session.query('UPDATE fiscal_rate SET rate_bp = 9999').catch(() => undefined);
    const after = await session.query<{ key: string; rate_bp: number }>(
      'SELECT key, rate_bp FROM fiscal_rate ORDER BY key',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('an admin cannot rewrite a published price version', async () => {
    const before = await session.query<{ id: string; unit_price_centimes: string }>(
      'SELECT id, unit_price_centimes::text FROM service_price ORDER BY id',
    );
    await session
      .query('UPDATE service_price SET unit_price_centimes = 1')
      .catch(() => undefined);
    await session.query('DELETE FROM service_price').catch(() => undefined);
    const after = await session.query<{ id: string; unit_price_centimes: string }>(
      'SELECT id, unit_price_centimes::text FROM service_price ORDER BY id',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('the activity log cannot be rewritten or erased', async () => {
    const before = await session.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM activity',
    );
    await session.query("UPDATE activity SET action = 'tampered'").catch(() => undefined);
    await session.query('DELETE FROM activity').catch(() => undefined);
    const after = await session.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM activity',
    );
    const tampered = await session.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM activity WHERE action = 'tampered'",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(tampered.rows[0]!.n).toBe('0');
  });

  it('every guard trigger is switched on', async () => {
    const { rows } = await session.query<{ trigger_name: string; enabled: boolean }>(`
      SELECT t.tgname AS trigger_name, (t.tgenabled = 'O') AS enabled
        FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND t.tgname IN ('document_immutable','document_line_immutable',
                          'service_price_immutable','fiscal_rate_immutable',
                          'activity_append_only','task_signoff','task_insert_guard',
                          'document_posts_revenue')`);
    // Eight guards, and a disabled one is how invoice immutability silently
    // vanished once already.
    expect(rows.length).toBe(8);
    expect(rows.filter((r) => !r.enabled)).toEqual([]);
  });

  it('the bootstrap door is closed to a signed-in session', async () => {
    const { rows } = await session.query<{ is_bootstrap: boolean; is_admin: boolean }>(
      'SELECT app.is_bootstrap() AS is_bootstrap, app.is_admin() AS is_admin',
    );
    // Admin, yes. Bootstrap, never — that flag belongs to migrations alone.
    expect(rows[0]!.is_admin).toBe(true);
    expect(rows[0]!.is_bootstrap).toBe(false);
  });
});

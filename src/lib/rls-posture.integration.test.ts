import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The shape of the security model, asserted rather than assumed.
 *
 * Every rule in this application about who may read what is a row level
 * security policy. That only works while two things stay true, and both are
 * easy to lose silently:
 *
 *   1. Every table has RLS ENABLED and FORCED. A new table created without it
 *      is readable and writable by every signed-in person, and nothing
 *      anywhere complains — the page works, the tests pass, and a member can
 *      read the payroll. FORCE matters separately: without it the table's
 *      owner is exempt from its own policies.
 *
 *   2. The application role holds no privilege that lets it step around any of
 *      that: no BYPASSRLS, no SUPERUSER, and no DDL with which to disable a
 *      policy from inside a request.
 *
 * These were checked by hand during a security review. A check made by hand is
 * a check made once — this is the same check, made on every run.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('row level security posture (integration)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('every table has row level security enabled AND forced', async () => {
    const { rows } = await db.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    // A sanity check on the check: if this query ever returns nothing, the
    // assertions below would pass while proving nothing at all.
    expect(rows.length).toBeGreaterThan(15);

    const unprotected = rows
      .filter((r) => !r.enabled || !r.forced)
      .map((r) => `${r.relname} (enabled=${r.enabled}, forced=${r.forced})`);

    expect(
      unprotected,
      `\nThese tables are readable without a policy deciding who may see them:\n` +
        `  ${unprotected.join('\n  ')}\n` +
        `Add ENABLE and FORCE ROW LEVEL SECURITY, and explicit policies.\n`,
    ).toEqual([]);
  });

  it('every table with row level security has at least one policy', async () => {
    // RLS with no policy denies everything to the application role. That is
    // safe, and it is also a table nobody can read — which shows up as a page
    // that is mysteriously empty rather than as an error.
    const { rows } = await db.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
        ORDER BY c.relname`,
    );
    expect(
      rows.map((r) => r.relname),
      '\nThese tables have RLS on and no policy, so they are invisible to the ' +
        'application rather than protected by it.\n',
    ).toEqual([]);
  });

  it('the application role cannot step around any of it', async () => {
    const { rows } = await db.query<{
      rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean;
      rolcreaterole: boolean; rolreplication: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         FROM pg_roles WHERE rolname = 'vixart_app'`,
    );
    expect(rows, 'the application role vixart_app does not exist').toHaveLength(1);

    const role = rows[0]!;
    // BYPASSRLS is the one that matters most: with it, every policy in this
    // file becomes decoration.
    expect(role.rolbypassrls, 'vixart_app can bypass RLS').toBe(false);
    expect(role.rolsuper, 'vixart_app is a superuser').toBe(false);
    expect(role.rolcreatedb).toBe(false);
    expect(role.rolcreaterole).toBe(false);
    expect(role.rolreplication, 'vixart_app can stream the whole database').toBe(false);
  });

  it.skipIf(!APP)('the application role cannot create a table to hide data in', async () => {
    // No DDL from a request. A role that can CREATE TABLE can also make one
    // with no policy on it, and RLS has nothing to say about a table it was
    // never applied to.
    const app = new Client({ connectionString: APP });
    await app.connect();
    try {
      await expect(
        app.query('CREATE TABLE zzz_posture_probe (id int)'),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      // If the guard ever fails, do not leave the table behind.
      await app.query('DROP TABLE IF EXISTS zzz_posture_probe').catch(() => {});
      await app.end();
    }
  });

  it.skipIf(!APP)('the application role cannot turn a policy off', async () => {
    const app = new Client({ connectionString: APP });
    await app.connect();
    try {
      await expect(
        app.query('ALTER TABLE message DISABLE ROW LEVEL SECURITY'),
      ).rejects.toThrow(/must be owner|permission denied/i);
    } finally {
      await app.end();
    }
  });
});

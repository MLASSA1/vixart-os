import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Every SECURITY DEFINER function must decide for itself who may call it.
 *
 * These functions are owned by the superuser, so they run OUTSIDE row level
 * security — FORCE included. The table's policy never gets a say. That makes
 * the function's own opening check the entire boundary, and an unguarded one
 * hands its table to anyone who can reach a server action that calls it.
 *
 * app.post_due_recurring() shipped without a guard and was reachable from
 * three actions on /finance. The page redirects a non-admin away, which
 * protects RENDERING and not the endpoint behind it.
 *
 * The first test below is the general rule, so a future function inherits it
 * without anyone remembering to write a test.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

/**
 * Deliberately exempt, each for a stated reason:
 *   lookup_login — must answer before anyone is authenticated; that IS the
 *     login path. Narrow: one row, by email.
 *   actor_name — reads a display name for the activity log, called from
 *     triggers under every role. Leaks nothing a colleague cannot see.
 *   set_own_password — writes only WHERE id = app.current_user_id(), which is
 *     a tighter guard than a role check.
 */
const EXEMPT = new Set(['lookup_login', 'actor_name', 'set_own_password']);

describe.skipIf(!HAS_DB)('SECURITY DEFINER functions guard their callers', () => {
  let db: Client;
  beforeAll(async () => { db = new Client({ connectionString: URL }); await db.connect(); });
  afterAll(async () => { await db?.end(); });

  it('every definer function checks who is calling', async () => {
    const { rows } = await db.query<{ name: string; src: string }>(
      `SELECT p.proname AS name, p.prosrc AS src
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.prosecdef`,
    );
    expect(rows.length).toBeGreaterThan(5);

    const unguarded = rows
      .filter((r) => !EXEMPT.has(r.name))
      .filter((r) => !/is_admin|is_bootstrap|is_moderator|current_user_id/.test(r.src))
      .map((r) => r.name);

    expect(
      unguarded,
      `\nThese SECURITY DEFINER functions run outside RLS and check nobody:\n` +
        `  ${unguarded.join(', ')}\n` +
        `Add a guard, or add the name to EXEMPT with the reason it is safe.\n`,
    ).toEqual([]);
  });

  it.skipIf(!APP)('refuses a member paying a charge or taking a number', async () => {
    const app = new Client({ connectionString: APP });
    await app.connect();
    try {
      const member = await db.query<{ id: string }>(
        `SELECT id FROM app_user WHERE role='member' AND password_hash NOT LIKE 'NO-LOGIN%' LIMIT 1`);
      await app.query(`SELECT set_config('app.user_id',$1,false)`, [member.rows[0]!.id]);
      await app.query(`SELECT set_config('app.user_role','member',false)`);
      await expect(app.query(`SELECT app.pay_charge(gen_random_uuid(), '2026-01', 100, current_date, 'virement')`))
        .rejects.toThrow(/Only management/i);
      await expect(app.query(`SELECT app.unpay_charge(gen_random_uuid(), '2026-01')`))
        .rejects.toThrow(/Only management/i);
      await expect(app.query(`SELECT * FROM app.next_document_number('facture', 2026)`))
        .rejects.toThrow(/Only management/i);
    } finally { await app.end(); }
  });

  it.skipIf(!APP)('still lets an admin through', async () => {
    const app = new Client({ connectionString: APP });
    await app.connect();
    try {
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM app_user WHERE role='admin' LIMIT 1`);
      await app.query(`SELECT set_config('app.user_id',$1,false)`, [admin.rows[0]!.id]);
      await app.query(`SELECT set_config('app.user_role','admin',false)`);
      const r = await app.query<{ n: number }>(
        `SELECT app.unpay_charge(gen_random_uuid(), '2026-01') AS n`);
      expect(r.rows[0]!.n).toBe(0);   // nothing to remove, and no refusal
    } finally { await app.end(); }
  });

  it('keeps money attachments out of the work-delete policy', async () => {
    const { rows } = await db.query<{ qual: string }>(
      `SELECT qual FROM pg_policies WHERE tablename='attachment' AND policyname='attachment_work_delete'`);
    expect(rows[0]!.qual).toContain('entity_type');
  });
});

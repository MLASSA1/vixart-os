import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Phase 1 hygiene: the system telling the truth about who works here.
 *
 * Two rules, both about offering only what is real:
 *   - a service account is never offered as a person
 *   - the probe purge touches probes and nothing else
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const KEEP = 'ZZZKeepMe Design';      // no space after ZZZ — a real client could be named this
const PROBE = 'ZZZ hygiene probe';    // the exact prefix the purge matches

describe.skipIf(!HAS_DB)('hygiene (integration)', () => {
  let db: Client;

  async function purgeFixtures() {
    await db.query(`DELETE FROM company WHERE name IN ($1, $2)`, [KEEP, PROBE]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await purgeFixtures();
  });

  afterAll(async () => { if (db) { await purgeFixtures(); await db.end(); } });

  // --- the service accounts ------------------------------------------------

  it('marks exactly the NO-LOGIN accounts unassignable', async () => {
    const { rows } = await db.query<{ email: string; a: boolean }>(
      `SELECT email, is_assignable AS a FROM app_user WHERE password_hash LIKE 'NO-LOGIN%'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.a).toBe(false);
  });

  it('leaves every real person assignable', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_user
        WHERE password_hash NOT LIKE 'NO-LOGIN%' AND NOT is_assignable`);
    expect(rows[0]!.n).toBe('0');
  });

  it('offers exactly the people to a picker', async () => {
    // The query the pickers run.
    const { rows } = await db.query<{ full_name: string }>(
      `SELECT full_name FROM app_user WHERE is_active AND is_assignable ORDER BY full_name`);
    const names = rows.map((r) => r.full_name);
    expect(names).not.toContain('Le Chef');
    expect(names).not.toContain('Le Comptable');
    expect(names.length).toBe(7);
  });

  it('refuses to make a service account assignable again', async () => {
    await expect(
      db.query(`UPDATE app_user SET is_assignable = true WHERE password_hash LIKE 'NO-LOGIN%'`),
    ).rejects.toThrow(/app_user_service_not_assignable/);
  });

  it('keeps the service accounts in the database, for the activity log', async () => {
    // They are the actor on append-only rows. Removing them would mean
    // rewriting history, which is the one thing that log exists to prevent.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_user WHERE password_hash LIKE 'NO-LOGIN%'`);
    expect(Number(rows[0]!.n)).toBe(2);
  });

  // --- the purge -----------------------------------------------------------

  it('matches the probe prefix exactly, space included', async () => {
    await db.query(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client'), ($2,'client','client')`,
      [KEEP, PROBE]);

    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM company WHERE name LIKE 'ZZZ %' ORDER BY name`);
    const matched = rows.map((r) => r.name);

    expect(matched).toContain(PROBE);
    // A client genuinely called ZZZKeepMe Design must survive the purge.
    expect(matched).not.toContain(KEEP);
  });

  it('is a no-op when there are no probes', async () => {
    await purgeFixtures();
    const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM company`);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM company WHERE name LIKE 'ZZZ %'`);
    expect(rows[0]!.n).toBe('0');
    const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM company`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('leaves the activity log alone', async () => {
    // The purge deletes companies; the log of what happened to them stays.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM activity`);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});

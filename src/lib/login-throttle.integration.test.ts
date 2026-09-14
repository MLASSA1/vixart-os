import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Password guessing has to get slower, and the refusal has to look ordinary.
 *
 * The sign-in page is public and sits in front of the agency's books. bcrypt
 * at cost 12 costs an attacker about 250 ms a try, which is four a second —
 * enough to work through a weak password in a weekend, against an address
 * printed on every invoice the agency sends.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const VICTIM = 'zzz-throttle-probe@vixart.local';
const OTHER = 'zzz-throttle-other@vixart.local';
const IP = '203.0.113.77';       // TEST-NET-3, never a real client

describe.skipIf(!HAS_DB)('login throttling (integration)', () => {
  let db: Client;

  async function purge() {
    await db.query(`DELETE FROM login_attempt WHERE email LIKE 'zzz-throttle%' OR ip = $1`, [IP]);
  }
  const fail = (email: string, ip: string | null = IP) =>
    db.query(`SELECT app.record_login_attempt($1, $2, false)`, [email, ip]);
  const gate = async (email: string, ip: string | null = IP) =>
    Number((await db.query<{ r: string }>(
      `SELECT app.login_retry_after($1, $2) AS r`, [email, ip])).rows[0]!.r);

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await purge();
  });

  afterAll(async () => { if (db) { await purge(); await db.end(); } });

  it('lets an honest mistake through', async () => {
    for (let i = 0; i < 5; i += 1) await fail(VICTIM);
    expect(await gate(VICTIM)).toBe(0);   // five wrong tries is a person, not a script
  });

  it('shuts the account after eight tries, and says how long', async () => {
    for (let i = 0; i < 3; i += 1) await fail(VICTIM);
    const wait = await gate(VICTIM);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(15 * 60);
  });

  it('does not punish a different account from the same office', async () => {
    // Per-account, not per-building: one person locked out must not lock the
    // rest of the team out with them.
    expect(await gate(OTHER)).toBe(0);
  });

  it('a correct password clears the account\'s failures immediately', async () => {
    expect(await gate(VICTIM)).toBeGreaterThan(0);
    await db.query(`SELECT app.record_login_attempt($1, $2, true)`, [VICTIM, IP]);
    expect(await gate(VICTIM)).toBe(0);
  });

  it('blocks one address spraying many accounts', async () => {
    await purge();
    // Thirty different addresses, one source — a stuffing list, not a person.
    for (let i = 0; i < 30; i += 1) await fail(`zzz-throttle-${i}@vixart.local`);
    // No single account is near its own limit …
    expect(
      Number((await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM login_attempt WHERE email='zzz-throttle-0@vixart.local' AND NOT ok`
      )).rows[0]!.n),
    ).toBe(1);
    // … but the source is.
    expect(await gate('zzz-throttle-99@vixart.local')).toBeGreaterThan(0);
  });

  it('an untouched address is unaffected by someone else being blocked', async () => {
    expect(await gate('zzz-throttle-clean@vixart.local', '198.51.100.9')).toBe(0);
  });

  it('forgets old failures rather than holding a grudge', async () => {
    await purge();
    for (let i = 0; i < 10; i += 1) await fail(VICTIM);
    expect(await gate(VICTIM)).toBeGreaterThan(0);
    // Age them past the window: the block must lift itself, with nobody asked.
    await db.query(
      `UPDATE login_attempt SET at = now() - interval '16 minutes' WHERE email = $1`, [VICTIM]);
    expect(await gate(VICTIM)).toBe(0);
  });

  it('records a successful sign-in without an ip, if there is none', async () => {
    await db.query(`SELECT app.record_login_attempt($1, NULL, true)`, [VICTIM]);
    expect(await gate(VICTIM, null)).toBe(0);
  });
});

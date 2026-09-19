import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The suite must not be able to touch the working database.
 *
 * THIS IS NOT A BROKEN TEST. DO NOT MAKE IT PASS BY CHANGING WHAT IT ALLOWS.
 *
 * Four separate times, a test damaged real data: an account demoted and
 * switched off, 44 fake notifications delivered to three real inboxes, a file
 * attachment deleted by an unscoped DELETE, and every probe document in
 * invoicing.integration.test.ts hung off a real client because it selected
 * `FROM company LIMIT 1`.
 *
 * Every one was fixed at the site. None of them prevented the next one, because
 * the fault is not any of those lines — it is that the suite was pointed at a
 * database it had no business writing to.
 *
 * It now runs against `vixart_test`, built by scripts/test-db.ts and rebuilt
 * with `npm run test:db:reset`. This file is what stops that arrangement being
 * quietly undone: if the connection is not the test database, the suite fails
 * here rather than proceeding to write somewhere it should not.
 *
 * If this fails, the fix is to point the run at the test database — never to
 * widen the check.
 */

const URL_ = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;

/** The one database the suite is allowed to write to. */
const EXPECTED = 'vixart_test';

function databaseOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

describe('database isolation', () => {
  it('runs against the test database, not the working one', () => {
    const name = databaseOf(URL_);
    expect(
      name,
      'DATABASE_URL is not set. vitest.config.ts rewrites it; if it is empty, ' +
        'that rewrite is gone.',
    ).not.toBeNull();
    expect(
      name,
      `The suite is pointed at "${name}", not "${EXPECTED}". It has damaged the ` +
        'working database four times. Run `npm test`, which provisions and ' +
        'selects the test database — do not widen this check.',
    ).toBe(EXPECTED);
  });

  it('points the application role at the same database', () => {
    // A test asserting RLS connects as the application role. If that one still
    // pointed at the working database, every policy assertion would be made
    // against real rows.
    if (!APP_URL) return;
    expect(databaseOf(APP_URL)).toBe(EXPECTED);
  });

  it('is a database the suite is free to destroy', async () => {
    // Belt and braces: the name could match while the connection does not.
    // Ask the server what it is actually connected to.
    if (!URL_) return;
    const c = new Client({ connectionString: URL_, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
    } catch {
      return; // No database at all: the integration files skip themselves.
    }
    try {
      const { rows } = await c.query<{ db: string }>('SELECT current_database() AS db');
      expect(rows[0]!.db).toBe(EXPECTED);
    } finally {
      await c.end();
    }
  });

  it('is migrated to the same point as the repository', async () => {
    // Running `npx vitest` directly skips scripts/test-db.ts, so the test
    // database keeps whatever schema it had last time. The failure that
    // produces is a bare 'relation "x" does not exist' in whichever test
    // happens to touch the new table — which reads like a broken feature
    // rather than a stale database. It has cost time twice.
    if (!URL_) return;
    const c = new Client({ connectionString: URL_, connectionTimeoutMillis: 2000 });
    try { await c.connect(); } catch { return; }
    try {
      const { rows } = await c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations');
      const journal = JSON.parse(
        readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
      ) as { entries: unknown[] };
      expect(
        Number(rows[0]!.n),
        `The test database is ${rows[0]!.n} migrations behind the repository's ` +
          `${journal.entries.length}. Run \`npm test\`, which provisions it — ` +
          '`npx vitest` alone does not.',
      ).toBe(journal.entries.length);
    } finally {
      await c.end();
    }
  });

});

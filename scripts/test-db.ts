/**
 * VIXART OS — the database the tests run against.
 *
 * WHY THIS EXISTS
 *
 * The integration suite used to connect to the working database: the one
 * holding Amin's real clients, real invoices and real team accounts. It went
 * wrong four separate times, and never in the same way twice —
 *
 *   a team test demoted his admin account and switched it off;
 *   probe runs filled three real inboxes with 44 fake notifications;
 *   an unscoped DELETE removed a file attachment of his;
 *   invoicing.integration.test.ts hung every probe document off
 *     `SELECT id FROM company LIMIT 1`, which is a real client.
 *
 * Each was fixed where it was found. That is fixing the same class of fault
 * once per occurrence, which is not the same as preventing it: the next test
 * anyone writes has exactly the same reach as the four that caused this.
 *
 * So the tests get their own database. Real data is not there to be damaged,
 * and `db-isolation.integration.test.ts` refuses to let the suite run against
 * a database that looks like the working one — so the isolation cannot be
 * quietly lost later by an env change.
 *
 * Rebuilt from nothing with `npm run test:db:reset`. Otherwise it is created
 * on first use and then migrated forward, which is a no-op once it is current.
 */

import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TEST_DB = 'vixart_test';

/**
 * Load .env the way the app and vitest.config do.
 *
 * npm does not do it, so run through `npm test` this script would otherwise
 * see no DATABASE_URL, no APP_DB_USER and no seed password — and fail in a way
 * that looks like a broken script rather than a missing environment.
 * `.env.local` wins, and an explicit export beats both.
 */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    const full = path.resolve(process.cwd(), file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      if (process.env[key] !== undefined) continue;
      process.env[key] = match[2]!.trim().replace(/^["'](.*)["']$/, '$1');
    }
  }
}

loadEnvFiles();

function urlFor(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

async function databaseExists(adminUrl: string): Promise<boolean> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    return rows.length > 0;
  } finally {
    await c.end();
  }
}

async function drop(adminUrl: string): Promise<void> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    // Anything still connected would block the DROP.
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [TEST_DB]);
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  } finally {
    await c.end();
  }
}

async function create(adminUrl: string): Promise<void> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await c.end();
  }
}

function run(script: string, env: NodeJS.ProcessEnv): void {
  execFileSync('node_modules/.bin/tsx', [script], {
    stdio: 'inherit',
    env,
  });
}

async function main() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL missing: see .env.example');

  // Guard against the obvious catastrophe: this script drops a database.
  if (new URL(base).pathname === `/${TEST_DB}`) {
    throw new Error(
      `DATABASE_URL already points at ${TEST_DB}. This script expects the owner ` +
        'connection to the working database and derives the test one from it.',
    );
  }

  const adminUrl = urlFor(base, 'postgres');
  const testUrl = urlFor(base, TEST_DB);
  const reset = process.argv.includes('--reset');

  if (reset) {
    console.log(`[test-db] dropping ${TEST_DB}`);
    await drop(adminUrl);
  }

  if (!(await databaseExists(adminUrl))) {
    console.log(`[test-db] creating ${TEST_DB}`);
    await create(adminUrl);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: testUrl,
    // The seed refuses to run without one, and this database is thrown away.
    SEED_DEFAULT_PASSWORD: process.env.SEED_DEFAULT_PASSWORD ?? 'test-password-0000',
    // Never the real client list: it is not needed, and a test database has no
    // business holding it.
    SEED_GENERIC: '1',
  };
  if (process.env.APP_DATABASE_URL) {
    env.APP_DATABASE_URL = urlFor(process.env.APP_DATABASE_URL, TEST_DB);
  }

  run('scripts/migrate.ts', env);
  run('scripts/apply-grants.ts', env);
  run('seed/vixart.seed.ts', env);
  // The public catalogue. The portal tests read it, and a suite that had to be
  // told to import it first would be a suite that passes on one machine.
  run('scripts/import-systems.ts', env);

  console.log(`[test-db] ready — ${TEST_DB}`);
}

main().catch((error) => {
  console.error('[test-db] FAILED:', error);
  process.exit(1);
});

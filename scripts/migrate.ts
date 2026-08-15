/**
 * VIXART OS — applying migrations.
 *
 * Reads the numbered SQL files in `drizzle/` and applies only the missing ones,
 * recording them in the `drizzle.__drizzle_migrations` journal.
 *
 * ⚠️  This is the ONLY allowed way to change the schema in production.
 *     `drizzle-kit push` is never run against a database holding real records:
 *     it alters the schema without leaving a trace and can silently drop
 *     columns.
 *
 * Idempotent: re-running against an up-to-date database does nothing.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import path from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing: see .env.example');

  const folder = path.resolve(process.cwd(), 'drizzle');
  console.log(`[migrate] folder: ${folder}`);

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const before = await countMigrations(client);
    const db = drizzle(client);

    await migrate(db, { migrationsFolder: folder });

    const after = await countMigrations(client);
    const applied = after - before;

    if (applied === 0) {
      console.log(`[migrate] already up to date (${after} migration(s) journalled)`);
    } else {
      console.log(`[migrate] ${applied} migration(s) applied — ${after} total`);
    }
  } finally {
    await client.end();
  }
}

async function countMigrations(client: Client): Promise<number> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
     ) AS present`,
  );
  if (!rows[0]?.present) return 0;

  const { rows: total } = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations',
  );
  return Number(total[0]?.n ?? 0);
}

main().catch((error) => {
  console.error('[migrate] FAILED:', error);
  process.exit(1);
});

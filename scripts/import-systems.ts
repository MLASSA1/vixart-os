/**
 * Load the twenty-five systems into `growth_system`.
 *
 *   docker compose exec app node_modules/.bin/tsx scripts/import-systems.ts
 *
 * Reads `seed/systems.json`, which was extracted from visionxart.com once and
 * committed. The portal does NOT fetch the website at request time, and should
 * not: the marketing site going down would take the client catalogue with it,
 * and a client waiting on another server is a dependency nobody chose. When
 * the website changes, re-extract and re-run this.
 *
 * Idempotent, keyed on the website's own slug: running it twice updates
 * twenty-five rows rather than creating fifty. A system that has been removed
 * from the site is DEACTIVATED rather than deleted — it may already be named
 * in a conversation with a client, and a row that vanishes takes that context
 * with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

interface SystemRow {
  slug: string;
  name: string;
  family: string;
  position: number;
  what_it_fixes: string;
  what_it_is: string;
  what_you_get: string[];
  who_it_is_for: string;
  image: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function main() {
  const file = join(process.cwd(), 'seed/systems.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')) as SystemRow[];

  // A truncated or half-written catalogue should not quietly replace a whole
  // one. Twenty-five is what the site says it has, in four families.
  const families = new Set(rows.map((r) => r.family));
  if (rows.length < 20 || families.size !== 4) {
    throw new Error(
      `seed/systems.json looks wrong: ${rows.length} systems in ${families.size} ` +
        `families. Expected about 25 in 4. Refusing to import.`,
    );
  }

  const db = new Client({ connectionString: requireEnv('DATABASE_URL') });
  await db.connect();

  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL app.bootstrap = 'on'");

    for (const r of rows) {
      await db.query(
        `INSERT INTO growth_system
           (slug, name, family, position, what_it_fixes, what_it_is,
            what_you_get, who_it_is_for, image, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
         ON CONFLICT (slug) DO UPDATE SET
           name          = EXCLUDED.name,
           family        = EXCLUDED.family,
           position      = EXCLUDED.position,
           what_it_fixes = EXCLUDED.what_it_fixes,
           what_it_is    = EXCLUDED.what_it_is,
           what_you_get  = EXCLUDED.what_you_get,
           who_it_is_for = EXCLUDED.who_it_is_for,
           image         = EXCLUDED.image,
           is_active     = true,
           updated_at    = now()`,
        [r.slug, r.name, r.family, r.position, r.what_it_fixes, r.what_it_is,
         r.what_you_get, r.who_it_is_for, r.image],
      );
    }

    // Anything no longer on the website stops being offered, and stays on
    // record. A client who was told about it last month should still be able
    // to find what it was.
    const retired = await db.query<{ slug: string }>(
      `UPDATE growth_system SET is_active = false, updated_at = now()
        WHERE is_active AND slug <> ALL($1)
        RETURNING slug`,
      [rows.map((r) => r.slug)],
    );

    await db.query('COMMIT');

    console.log(`[systems] ${rows.length} imported or updated`);
    for (const f of ['Growth', 'Engineering', 'Production', 'Design']) {
      console.log(`[systems]   ${f}: ${rows.filter((r) => r.family === f).length}`);
    }
    if (retired.rowCount) {
      console.log(`[systems] retired (kept, no longer offered): ` +
        retired.rows.map((r) => r.slug).join(', '));
    }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('[systems] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});

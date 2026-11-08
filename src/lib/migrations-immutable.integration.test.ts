import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

/**
 * A migration that has been applied is immutable. This test is why.
 *
 * WHAT HAPPENED. 0077 was applied, and then I edited it — adding
 * `app.notify_retract` and a branch to `notify_on_task_change`. Drizzle
 * journals a migration once and thereafter reports "already up to date", so the
 * edit ran nowhere. The function sat in the file, read correctly, type-checked
 * (SQL is not type-checked at all), and existed in no database. The
 * definer-guard test raised nothing, because the function it would have
 * inspected was not there to inspect. The suite was green and the feature did
 * not exist.
 *
 * The worst part was which environment was wrong. Production had never applied
 * 0077, so it would have received the whole file and been correct; the only
 * database missing the change was the disposable one I verify against — the one
 * telling me the work was done.
 *
 * WHY A HASH CATCHES IT. Drizzle stores a sha256 of each migration's text when
 * it applies it, in `drizzle.__drizzle_migrations`, in journal order. If a file
 * on disk no longer hashes to what was stored, that file has been edited since
 * it ran, and the difference is live in nobody's database. There is no way to
 * apply it other than a new migration, so this test says so by name.
 *
 * It does not care about migrations that have not been applied yet — those are
 * still free to change, which is the whole distinction.
 */

const URL = process.env.DATABASE_URL;
const DIR = path.resolve(process.cwd(), 'drizzle');

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

interface Entry { idx: number; tag: string }

describe.skipIf(!HAS_DB)('applied migrations are immutable (integration)', () => {
  let db: Client;
  beforeAll(async () => { db = new Client({ connectionString: URL }); await db.connect(); });
  afterAll(async () => { await db?.end(); });

  it('every applied migration still hashes to the file on disk', async () => {
    const journal = JSON.parse(
      await readFile(path.join(DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Entry[] };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

    const { rows } = await db.query<{ hash: string }>(
      `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`,
    );

    // Drizzle applies in journal order, so row N is entry N. Only the applied
    // prefix is checked; anything beyond it has not run and may still change.
    expect(rows.length).toBeLessThanOrEqual(entries.length);

    const edited: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const entry = entries[i]!;
      const sql = await readFile(path.join(DIR, `${entry.tag}.sql`), 'utf8');
      const onDisk = createHash('sha256').update(sql).digest('hex');
      if (onDisk !== rows[i]!.hash) edited.push(entry.tag);
    }

    expect(
      edited,
      `\nThese migrations were edited after they were applied, so the edit is ` +
        `live in no database:\n  ${edited.join('\n  ')}\n\n` +
        `A migration that has run is immutable. Put the change in a NEW ` +
        `migration — CREATE OR REPLACE makes it safe to re-state a function ` +
        `the previous one already defined.\n`,
    ).toEqual([]);
  });

  it('every journalled migration has a file, and every file is journalled', async () => {
    const journal = JSON.parse(
      await readFile(path.join(DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Entry[] };

    // A file nobody journalled never runs; a journal entry with no file throws
    // mid-deploy, which is the worse of the two.
    for (const entry of journal.entries) {
      await expect(
        readFile(path.join(DIR, `${entry.tag}.sql`), 'utf8'),
        `${entry.tag} is journalled but has no .sql file`,
      ).resolves.toBeTypeOf('string');
    }

    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    const tags = new Set(journal.entries.map((e) => e.tag));
    const orphans = files.map((f) => f.replace(/\.sql$/, '')).filter((t) => !tags.has(t));

    expect(
      orphans,
      `\nThese .sql files are not in meta/_journal.json, so they never run:\n` +
        `  ${orphans.join('\n  ')}\n`,
    ).toEqual([]);
  });

  it('the indexes are contiguous from zero, so none was skipped', async () => {
    const journal = JSON.parse(
      await readFile(path.join(DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Entry[] };
    const idx = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idx).toEqual(idx.map((_, i) => i));
  });
});

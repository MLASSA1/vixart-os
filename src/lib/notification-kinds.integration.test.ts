import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every kind of notification reads as a sentence, not as a column value.
 *
 * The inbox maps a kind to a label and a tone. Both maps were written with four
 * kinds in them and the constraint now allows seven — `task_blocked` arrived in
 * 0063 and was never given a label, so for weeks the inbox printed the literal
 * string "task_blocked" to whoever was told their task was stuck.
 *
 * Nothing failed. That is the whole problem: a page rendering a database
 * identifier still looks like a page, and the reader assumes the odd word means
 * something. The only way to catch it is to ask the database what kinds exist
 * and check that somebody has decided how each one reads.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('every notification kind has been given words (integration)', () => {
  let db: Client;
  let kinds: string[] = [];

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'notification_kind_valid'`);
    // The constraint reads as an ARRAY['a'::text, 'b'::text, …] membership test.
    kinds = [...(rows[0]?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
  });

  afterAll(async () => { await db?.end(); });

  const inbox = () =>
    readFileSync(join(process.cwd(), 'src/app/(app)/inbox/page.tsx'), 'utf8');

  it('reads the kinds off the constraint', () => {
    // If this comes back empty every assertion below passes vacuously.
    expect(kinds.length, 'no kinds parsed from notification_kind_valid').toBeGreaterThan(4);
    expect(kinds).toContain('task_assigned');
  });

  it('gives every kind a label in the inbox', () => {
    const source = inbox();
    const labels = source.slice(
      source.indexOf('const KIND_LABEL'),
      source.indexOf('const KIND_TONE'),
    );
    const missing = kinds.filter((k) => !labels.includes(`${k}:`));
    expect(
      missing,
      `\nThese notification kinds have no label — the inbox prints the raw value:\n` +
        `  ${missing.join(', ')}\n`,
    ).toEqual([]);
  });

  it('gives every kind a tone', () => {
    const source = inbox();
    const tones = source.slice(
      source.indexOf('const KIND_TONE'),
      source.indexOf('interface Row'),
    );
    const missing = kinds.filter((k) => !tones.includes(`${k}:`));
    expect(
      missing,
      `\nThese notification kinds have no tone, so they render unstyled:\n  ${missing.join(', ')}\n`,
    ).toEqual([]);
  });

  it('labels nothing that the database would refuse', () => {
    // The other direction. A label for a kind no trigger can produce is dead
    // code that reads as a feature.
    const source = inbox();
    const labels = source.slice(
      source.indexOf('const KIND_LABEL'),
      source.indexOf('const KIND_TONE'),
    );
    const declared = [...labels.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]!);
    const unknown = declared.filter((k) => !kinds.includes(k));
    expect(unknown, `\nLabels for kinds the constraint does not allow:\n  ${unknown.join(', ')}\n`).toEqual([]);
  });
});

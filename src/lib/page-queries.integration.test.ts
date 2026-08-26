import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Every read query in the app must at least PLAN.
 *
 * Written after /finance had been dead for nine days. The query referenced an
 * ungrouped outer column from inside a sublink — illegal in PostgreSQL, but
 * perfectly well-typed TypeScript, so `tsc` was happy and nothing ran it. The
 * same shape of failure had already hit /system once, where a query still named
 * a table that had been renamed six migrations earlier.
 *
 * The gap is structural: SQL in this codebase is a template string. The type
 * checker sees text. The only thing that can tell us a query is wrong is
 * PostgreSQL, and until now nothing asked it.
 *
 * EXPLAIN asks. It parses, resolves every name, checks grouping and types, and
 * builds a plan — without executing anything or touching a row. That is enough
 * to catch missing columns, renamed tables, bad grouping and type errors, which
 * is nearly every way one of these queries has actually broken.
 *
 * What this does NOT check is whether the numbers are right; other tests do
 * that. This one only establishes that the query is legal SQL against the
 * schema as it exists today.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const HAS_DB = await reachable();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * Pull the body out of every sql`…` literal.
 *
 * Tracks `${` depth so a backtick nested inside an interpolation does not end
 * the scan early — and so this stays honest if someone nests a template.
 */
function extractSql(source: string): string[] {
  const found: string[] = [];
  const opener = /\bsql`/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(source))) {
    let i = match.index + match[0].length;
    let depth = 0;
    let body = '';
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') {
        body += c + (source[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') depth++;
      if (c === '}' && depth > 0) depth--;
      if (c === '`' && depth === 0) break;
      body += c;
    }
    found.push(body);
    opener.lastIndex = i;
  }
  return found;
}

describe.skipIf(!HAS_DB)('every page query plans against the real schema', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    // Read-only planning, but RLS is FORCEd even for the owner.
    await db.query("SET app.bootstrap = 'on'");
  });

  afterAll(async () => {
    await db?.end();
  });

  it('plans every SELECT and CTE in src/app and src/lib', async () => {
    const files = [...walk('src/app'), ...walk('src/lib')];
    const failures: string[] = [];
    let planned = 0;

    for (const file of files) {
      for (const raw of extractSql(readFileSync(file, 'utf8'))) {
        // Bound parameters are irrelevant to planning; NULL keeps the shape.
        const query = raw.replace(/\$\{[^}]*\}/g, 'NULL').trim();

        // Only reads. Planning an INSERT or UPDATE is safe in principle, but
        // not worth the risk of a stray statement against a live database.
        if (!/^(select|with)\b/i.test(query)) continue;
        planned++;

        try {
          await db.query('EXPLAIN ' + query);
        } catch (error) {
          const message = String((error as Error).message).split('\n')[0] ?? '';
          // A bare NULL sometimes leaves PostgreSQL unable to infer a type.
          // That is an artefact of the substitution above, not a fault in the
          // query, so it is not counted against the file.
          if (/could not determine|cannot determine|unknown/i.test(message)) continue;
          failures.push(`${file}\n    ${message}\n    ${(query.split('\n')[0] ?? '').slice(0, 80)}`);
        }
      }
    }

    // A guard that silently stops finding anything is worse than no guard, so
    // assert the scan itself still works.
    expect(planned).toBeGreaterThan(40);
    expect(failures, `\n${failures.join('\n\n')}\n`).toEqual([]);
  }, 60_000);
});

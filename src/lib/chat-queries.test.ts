import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every field the chat row types declare must actually be selected.
 *
 * Written immediately after shipping one that was not. `file_duration_ms` was
 * added to the MessageRow interface and the SELECT list was left alone, and
 * nothing anywhere complained: `tsc` cannot see inside a template literal, the
 * EXPLAIN planner test only asks PostgreSQL whether the query is legal — which
 * it still was — and the page rendered perfectly, just with the duration
 * permanently absent. A voice note that always says "Voice note" instead of
 * "0:07" is exactly the kind of quiet wrongness that survives a build, a type
 * check and a full test run.
 *
 * The rule is narrow and static: a name declared on the row type is a promise
 * that the query returns a column of that name. Here it is checked.
 */

const SOURCE = readFileSync(join(process.cwd(), 'src/lib/chat-queries.ts'), 'utf8');

/** Field names from `export interface X { … }`, minus the index signature. */
function declaredFields(name: string): string[] {
  const start = SOURCE.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`no interface ${name}`);
  const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  return [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\??:/gim)]
    .map((m) => m[1]!)
    .filter((f) => f !== 'k');
}

/**
 * Names the SQL actually produces: an explicit `AS alias`, or the trailing
 * part of a qualified column selected as-is (`m.author_id` gives author_id).
 */
function selectedNames(sqlText: string): Set<string> {
  const names = new Set<string>();
  for (const m of sqlText.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) names.add(m[1]!.toLowerCase());
  for (const m of sqlText.matchAll(/\b[a-z]\.([a-z_][a-z0-9_]*)/gi)) names.add(m[1]!.toLowerCase());
  return names;
}

/** The body of the sql`…` literal inside a named function. */
function queryOf(fn: string): string {
  const at = SOURCE.indexOf(`export async function ${fn}`);
  if (at === -1) throw new Error(`no function ${fn}`);
  const open = SOURCE.indexOf('sql`', at);
  return SOURCE.slice(open + 4, SOURCE.indexOf('`', open + 4));
}

describe('chat row types match their queries', () => {
  it('returns every field MessageRow declares', () => {
    const selected = selectedNames(queryOf('listMessages'));
    const missing = declaredFields('MessageRow').filter((f) => !selected.has(f));
    expect(missing, `MessageRow declares ${missing.join(', ')}, which the query never selects`)
      .toEqual([]);
  });

  it('returns every field ChannelRow declares', () => {
    const selected = selectedNames(queryOf('listChannels'));
    const missing = declaredFields('ChannelRow').filter((f) => !selected.has(f));
    expect(missing, `ChannelRow declares ${missing.join(', ')}, which the query never selects`)
      .toEqual([]);
  });

  it('can tell when a field is missing', () => {
    // The guard is only worth having if it fails on the thing it is for.
    const selected = selectedNames(queryOf('listMessages'));
    expect(selected.has('file_duration_ms')).toBe(true);
    expect(selected.has('file_loudness_lufs')).toBe(false);
  });
});

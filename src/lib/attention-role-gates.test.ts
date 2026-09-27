import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every branch of the attention query is scoped to somebody.
 *
 * "Needs attention" is one query of UNIONed branches, each returning a count and
 * sometimes a DETAIL — and some of those details are a client's name. Whether a
 * branch belongs to the person reading it, or to management, is decided by an
 * interpolated flag in its WHERE clause.
 *
 * One branch did not have one. `gone_quiet` returned min(company.name) with no
 * gate at all, so every member's own home screen named the client nobody had
 * spoken to in a month. It survived because the page LOOKS right either way: a
 * member sees a list of things needing attention, and no screenshot shows you
 * that one line was not meant for them.
 *
 * That matters more now than it did. The team space closes the client list, the
 * leads, the projects and the dashboard to a member — and a single ungated
 * branch here reopens a corner of it on a page they keep.
 *
 * So this reads the query and requires every branch to be scoped: to the reader
 * (`user.id`), or to a role. It is static and crude on purpose — it is checking
 * that a line was not forgotten, which is the only way this fails.
 */

const SOURCE = readFileSync(join(process.cwd(), 'src/lib/attention.ts'), 'utf8');

/** The one big query, from the template literal it lives in. */
function attentionQuery(): string {
  const at = SOURCE.indexOf('.execute<Row>(sql`');
  expect(at, 'the attention query is no longer a single tagged template').toBeGreaterThan(-1);
  const open = SOURCE.indexOf('sql`', at) + 4;
  return SOURCE.slice(open, SOURCE.indexOf('`', open));
}

/** The scoping expressions that count as an answer to "whose is this?" */
const GATES = ['${user.id}', '${isAdmin}', '${isModerator}', '${canSignOff}'];

describe('the attention query scopes every branch', () => {
  const query = attentionQuery();
  // Each UNION ALL arm, with its own SELECT and WHERE.
  const branches = query.split(/\bUNION ALL\b/);

  it('finds the branches at all', () => {
    // A rewrite that collapsed this into one SELECT would make the loop below
    // pass while checking nothing.
    expect(branches.length).toBeGreaterThan(8);
  });

  it('gates every branch to a person or a role', () => {
    const ungated = branches
      .map((b) => {
        const named = /SELECT\s+'([a-z_]+)'/.exec(b);
        return { kind: named?.[1] ?? '(unnamed)', text: b };
      })
      .filter((b) => b.kind !== '(unnamed)')
      .filter((b) => !GATES.some((g) => b.text.includes(g)))
      .map((b) => b.kind);

    expect(
      ungated,
      `\nThese attention branches are shown to everybody:\n  ${ungated.join(', ')}\n` +
        `Add \${isModerator}, \${isAdmin} or a filter on \${user.id} to the WHERE.\n` +
        `An ungated branch that returns a company name puts a client's name on\n` +
        `every member's home screen.\n`,
    ).toEqual([]);
  });

  it('keeps the detail column honest about which branches carry a name', () => {
    // Any branch selecting a company name must be management's. This is the
    // narrower version of the rule above, aimed at the specific leak.
    const naming = branches.filter((b) => /min\(c\.name\)/.test(b));
    expect(naming.length, 'no branch names a company any more — check this test').toBeGreaterThan(0);
    for (const b of naming) {
      const kind = /SELECT\s+'([a-z_]+)'/.exec(b)?.[1] ?? '(unnamed)';
      expect(
        b.includes('${isModerator}') || b.includes('${isAdmin}'),
        `branch ${kind} returns a client's name without a management gate`,
      ).toBe(true);
    }
  });
});

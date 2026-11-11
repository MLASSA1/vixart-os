import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every form driven by a server action keeps what was typed when the save is
 * refused.
 *
 * React 19 clears a `<form action={…}>` after its action settles, refused or
 * not, so one bad field used to empty every other field and they all had to be
 * typed again. `useKeepOnError` (src/lib/use-keep-on-error.ts) snapshots the
 * fields on submit and puts them back once a refusal has rendered. It is
 * opt-in — a hook and an `onSubmit` per form — and an opt-in rule is a rule
 * somebody forgets on the next form. This is what remembers.
 *
 * November 2026: 47 forms in 36 files.
 */

const ROOT = join(process.cwd(), 'src');
const tsx = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsx(p) : p.endsWith('.tsx') ? [p] : [];
  });

/** For each file: the actions that come from useActionState, and its form tags. */
function survey() {
  const out: { file: string; actions: string[]; unguarded: string[] }[] = [];
  for (const file of tsx(ROOT)) {
    const src = readFileSync(file, 'utf8');
    const actions = [...src.matchAll(/const \[[a-zA-Z]+,\s*([a-zA-Z]+)(?:,\s*[a-zA-Z]+)?\]\s*=\s*useActionState\(/g)].map((m) => m[1]!);
    if (actions.length === 0) continue;
    const unguarded = [...src.matchAll(/<form\b[^>]*>/gs)]
      .map((m) => m[0])
      .filter((tag) => actions.some((a) => tag.includes(`action={${a}}`)))
      .filter((tag) => !/onSubmit=\{keep[A-Z]\w*\}/.test(tag));
    out.push({ file: relative(process.cwd(), file), actions, unguarded });
  }
  return out;
}

describe('forms keep what was typed when a save is refused', () => {
  it('finds the forms it is guarding', () => {
    // If this drops, the patterns have stopped matching the code and the next
    // test would pass while guarding nothing.
    expect(survey().length).toBeGreaterThanOrEqual(30);
  });

  it('gives every action-driven form the keep-on-error hook', () => {
    const missing = survey().flatMap((s) => s.unguarded.map((tag) => `${s.file}: ${tag.slice(0, 70)}`));
    expect(
      missing,
      'a form driven by useActionState has no onSubmit={keep…}, so a refused save empties it',
    ).toEqual([]);
  });

  it('calls the hook with the same state the form renders', () => {
    // A keep… handler wired to a different state would restore on somebody
    // else's error. Each `keepX` must be `useKeepOnError(x)`.
    const wrong: string[] = [];
    for (const file of tsx(ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/const (keep([A-Z]\w*)) = useKeepOnError\((\w+)\)/g)) {
        const expected = m[2]![0]!.toLowerCase() + m[2]!.slice(1);
        if (m[3] !== expected) wrong.push(`${relative(process.cwd(), file)}: ${m[0]}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

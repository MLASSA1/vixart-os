import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every amount drawn as a big figure carries `kpi-money`.
 *
 * An amount is one unbreakable token: "36 000,00 DH" is written with
 * non-breaking spaces, so it cannot wrap. In a half-width column on a phone it
 * did not shrink either — it ran 23px into the next cell, and the screen read
 * "36 000,00 DH0,00 DH", two figures fused into one wrong number. Inside a
 * padded card on Finance the same figure had 114px for 174px of text.
 *
 * The fix is in globals.css: a `.kpi-money` inside a grid cell may never be
 * larger than 12% of that cell (the widest plausible amount is 7.66 times its
 * font size, a negative one a little more). It is opt-in because the same cap
 * shrank one-digit counts beside the amounts, and that is exactly why this
 * test exists — an opt-in rule is a rule somebody forgets, and the screen it
 * breaks is the phone nobody checked.
 *
 * Night studio, November 2026.
 */

const ROOT = join(process.cwd(), 'src');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Lines where an element with the `kpi` class directly renders an amount. */
function kpiAmountLines(): { at: string; line: string }[] {
  const found: { at: string; line: string }[] = [];
  for (const file of tsxFiles(ROOT)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // The PDF has its own layout engine and no grid cells.
        if (file.includes(join('lib', 'pdf'))) return;
        if (/className="[^"]*(?<![\w-])kpi(?![\w-])[^"]*"[^>]*>\{formatMAD\(/.test(line)) {
          found.push({ at: `${relative(process.cwd(), file)}:${i + 1}`, line: line.trim() });
        }
      });
  }
  return found;
}

describe('big money figures are capped to their own cell', () => {
  it('finds the amounts it is guarding', () => {
    // If this drops to zero the pattern above has stopped matching the code,
    // and the next test would pass while guarding nothing.
    expect(kpiAmountLines().length).toBeGreaterThanOrEqual(10);
  });

  it('marks every one of them kpi-money', () => {
    const unmarked = kpiAmountLines().filter((l) => !/(?<![\w-])kpi-money(?![\w-])/.test(l.line));
    expect(
      unmarked.map((l) => l.at),
      'an amount is rendered as a .kpi without kpi-money, so on a phone it can ' +
        'run out of its cell and into the next figure',
    ).toEqual([]);
  });

  it('keeps the cap in the stylesheet', () => {
    const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
    expect(css).toMatch(/:has\(> \.kpi-money\)\s*\{\s*container-type: inline-size;/);
    expect(css).toMatch(/> \.kpi-money\s*\{\s*font-size: min\([^;]*12cqi\);/);
  });
});

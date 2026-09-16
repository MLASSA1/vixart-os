import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A page may HAND OUT a server action. It may not RUN one.
 *
 * Written after every chat thread page returned 500 in production. The page
 * did this, during its render:
 *
 *     await markThreadReadAction(id);
 *
 * and that action ended in `revalidatePath('/chat')`. Next refuses to
 * revalidate during a render — reasonably, since the render is what the cache
 * entry is being built from — so the whole route threw. It type-checked, it
 * built, and it was deployed; the feature was simply unreachable, and the
 * notifications shipped after it linked into a 500.
 *
 * The shape of the mistake is what matters, not the instance. A server action
 * is written for a form submission: it is free to revalidate, to redirect, to
 * set a cookie. None of those are legal from inside a render. So calling one
 * during a render is a bet that this particular action happens not to do any
 * of them today — and that nobody adds one later.
 *
 * The rule is therefore blunt: inside a `page.tsx` or `layout.tsx`, an
 * identifier imported from an actions module may be passed as a prop, bound
 * with `.bind`, referenced — anything except invoked. Work a page genuinely
 * needs done during render goes in a plain function it can call safely, which
 * is what `@/lib/chat-read` now is.
 *
 * No database. This is a property of the source, and it should fail on a
 * laptop with nothing running.
 */

const APP = join(process.cwd(), 'src', 'app');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/^(page|layout)\.tsx$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Comments are prose. A rule that reads them reports on sentences. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every name a file pulls in from an actions module. */
function actionImports(source: string): string[] {
  const names: string[] = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const from = m[2] ?? '';
    if (!/(^|\/)actions$/.test(from)) continue;
    for (const raw of (m[1] ?? '').split(',')) {
      // `a as b` — the local name is what gets called.
      const local = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) names.push(local);
    }
  }
  return names;
}

const FILES = walk(APP);
const seen = FILES.map((f) => {
  const src = stripComments(readFileSync(f, 'utf8'));
  return { file: f.slice(process.cwd().length + 1), src, imported: actionImports(src) };
});

describe('render safety', () => {
  it('finds pages that import server actions, so the rule has something to check', () => {
    // Guards against the quiet failure mode: a scan that passes because it
    // matched nothing. If this ever drops to zero, the rule below is decoration.
    const withActions = seen.filter((s) => s.imported.length > 0);
    expect(FILES.length).toBeGreaterThan(20);
    expect(withActions.length).toBeGreaterThan(5);
  });

  it('never calls a server action during a render', () => {
    const offences: string[] = [];

    for (const { file, src, imported } of seen) {
      for (const name of imported) {
        // `name(` is a call. `name.bind(`, `action={name}`, `<name />` are not:
        // a dot or a closing brace sits between the name and the parenthesis.
        const called = new RegExp(String.raw`\b${name}\s*\(`).test(src);
        if (called) offences.push(`${file} calls ${name}()`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('never revalidates or redirects from a render', () => {
    const offences: string[] = [];

    for (const { file, src } of seen) {
      // `redirect()` is deliberately allowed: Next supports it from a render,
      // and several pages use it to bounce on a missing record.
      for (const banned of ['revalidatePath', 'revalidateTag']) {
        if (new RegExp(String.raw`\b${banned}\s*\(`).test(src)) {
          offences.push(`${file} calls ${banned}()`);
        }
      }
    }

    expect(offences).toEqual([]);
  });
});

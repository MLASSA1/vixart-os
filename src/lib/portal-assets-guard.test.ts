import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything the portal serves statically must be on the middleware's list.
 *
 * In portal mode the middleware answers 404 to any path it does not
 * recognise. That is the point — the internal application's pages must not be
 * reachable there. But the list is written by hand, and it has now silently
 * swallowed assets twice:
 *
 *   * the eight system hero images under `public/systems`, so the catalogue
 *     rendered perfectly with every picture missing;
 *   * `icon.png` and `apple-icon.png`, so the browser fell back to its own
 *     grey placeholder — which does not look like a missing file, it looks
 *     like a site that forgot to have a logo.
 *
 * Neither failed loudly. A 404 on an image is a gap on a page, and a page with
 * a gap still looks like a page.
 *
 * So this walks what actually exists and checks the list covers it. It is
 * static — no server, no build — because the failure it catches is somebody
 * adding a folder and not thinking about the middleware.
 */

const MIDDLEWARE = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8');
const APP = join(process.cwd(), 'src/app');
const PUBLIC = join(process.cwd(), 'public');

/**
 * The allowlist, as written — and the two kinds of rule kept apart.
 *
 * `path === '/'` and `path.startsWith('/portal')` are not the same test, and
 * reading both as prefixes makes `/` match everything: the first version of
 * this file concluded that /clients was reachable in the portal, which would
 * have been alarming had it been true.
 */
function allowlist(): { prefixes: string[]; exact: string[] } {
  const body = MIDDLEWARE.slice(
    MIDDLEWARE.indexOf('function allowedInPortal'),
    MIDDLEWARE.indexOf('export function middleware'),
  );
  return {
    prefixes: [...body.matchAll(/path\.startsWith\('([^']+)'\)/g)].map((m) => m[1]!),
    exact: [...body.matchAll(/path === '([^']+)'/g)].map((m) => m[1]!),
  };
}

function isAllowed(path: string, list: ReturnType<typeof allowlist>): boolean {
  return list.exact.includes(path) || list.prefixes.some((p) => path.startsWith(p));
}

describe('the portal can serve its own static files', () => {
  const list = allowlist();

  it('reads the allowlist at all', () => {
    // If this ever comes back empty the assertions below pass vacuously.
    expect(list.prefixes.length).toBeGreaterThan(4);
    expect(list.prefixes).toContain('/portal');
  });

  it('serves every metadata icon Next generates', () => {
    // Next turns these files in `src/app` into routes of the same name.
    const icons = ['favicon.ico', 'icon.png', 'apple-icon.png']
      .filter((f) => existsSync(join(APP, f)));

    expect(icons.length, 'no icon files at all — the tab will be blank').toBeGreaterThan(0);

    const blocked = icons.filter((f) => !isAllowed(`/${f}`, list));
    expect(
      blocked,
      `\nThese icons exist but the portal middleware 404s them:\n  ${blocked.join('\n  ')}\n` +
        'The browser falls back to its own grey placeholder.\n',
    ).toEqual([]);
  });

  it('serves everything in the public folder', () => {
    if (!existsSync(PUBLIC)) return;

    const entries = readdirSync(PUBLIC)
      // Dotfiles are bookkeeping, not assets: `.gitkeep` exists so an empty
      // directory survives a commit, and nothing ever requests it.
      .filter((name) => !name.startsWith('.'))
      .map((name) => {
        const full = join(PUBLIC, name);
        return statSync(full).isDirectory() ? `/${name}/` : `/${name}`;
      });

    const blocked = entries.filter((e) => !isAllowed(e, list));
    expect(
      blocked,
      `\nThese are served from public/ but the portal middleware 404s them:\n` +
        `  ${blocked.join('\n  ')}\n` +
        'Add them to allowedInPortal, or the portal renders pages with holes.\n',
    ).toEqual([]);
  });

  it('still refuses the internal application', () => {
    // The other half. A list that allowed everything would pass the tests
    // above and defeat the purpose of having one.
    for (const path of ['/clients', '/finance', '/documents', '/chat', '/team']) {
      expect(isAllowed(path, list), `${path} is reachable in the portal`).toBe(false);
    }
  });
});

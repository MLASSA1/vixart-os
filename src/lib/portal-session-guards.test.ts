import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A portal page with no session REDIRECTS. It does not throw.
 *
 * THIS IS NOT A BROKEN TEST. DO NOT DELETE IT.
 *
 * The guarded layout redirects a visitor who is not a signed-in client, and
 * that looked like enough. It is not: in the App Router a layout and the page
 * inside it render CONCURRENTLY, so the layout's redirect does not stop the
 * page from running. A page calling `requireClientSession()` — which throws —
 * threw anyway.
 *
 * On a fresh request the redirect usually won the race and nobody saw it. On a
 * client-side navigation it did not, and what the client got was Next's error
 * screen: "something went wrong, try again". It took a day to appear, because
 * a session lasts twelve hours and the first day everybody was signed in.
 *
 * `requireClientPage()` redirects instead, and `redirect()` raises a signal
 * Next understands rather than an error it reports. Every guarded page must
 * use it; the throwing version is for server actions, which have no page to
 * send anybody to.
 */

const GUARDED = join(process.cwd(), 'src/app/(portal)/portal/(guarded)');

function pagesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...pagesUnder(full));
    else if (entry === 'page.tsx') found.push(full);
  }
  return found;
}

describe('portal pages redirect rather than throw', () => {
  const pages = pagesUnder(GUARDED);

  it('finds the guarded pages at all', () => {
    // A rename that empties this list would make every assertion below pass
    // while checking nothing.
    expect(pages.length).toBeGreaterThanOrEqual(4);
  });

  it('no guarded page calls the throwing guard', () => {
    const offenders = pages
      .filter((p) => readFileSync(p, 'utf8').includes('requireClientSession'))
      .map((p) => p.replace(process.cwd() + '/', ''));

    expect(
      offenders,
      '\nThese pages use requireClientSession(), which THROWS.\n' +
        `  ${offenders.join('\n  ')}\n` +
        'A visitor whose session has expired will see Next\'s error screen\n' +
        'instead of the sign-in page. Use requireClientPage().\n',
    ).toEqual([]);
  });

  it('every guarded page asks for the session through the redirecting guard', () => {
    const missing = pages
      .filter((p) => !readFileSync(p, 'utf8').includes('requireClientPage'))
      .map((p) => p.replace(process.cwd() + '/', ''));

    expect(
      missing,
      `\nThese pages never establish who is signed in:\n  ${missing.join('\n  ')}\n`,
    ).toEqual([]);
  });

  it('the redirecting guard actually redirects', () => {
    const source = readFileSync(join(GUARDED, 'session.ts'), 'utf8');
    expect(source).toContain("redirect('/portal/sign-in')");
    // And refuses a session that is a client but carries no company — the
    // portal's queries all hang off that.
    expect(source).toContain('companyId');
  });

  it('the portal has an error screen of its own', () => {
    // Belt and braces for whatever throws next: the default is "Application
    // error: a client-side exception has occurred", which reads to a client as
    // the whole thing being broken.
    const boundary = readFileSync(
      join(process.cwd(), 'src/app/(portal)/error.tsx'), 'utf8');
    expect(boundary).toContain("'use client'");
    expect(boundary).toContain('reset');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A cached file is still a checked file.
 *
 * Attachments became cacheable because `no-store` meant every photograph in a
 * channel was downloaded again on every page load, every scroll back and every
 * reconnect — over mobile data, for bytes the browser already had.
 *
 * The hazard that comes with it is specific and quiet. `If-None-Match` is a
 * request that can be answered without touching the file, and answering it
 * early is the obvious optimisation: the bytes are not being sent, so what is
 * there to check? The answer is whether this person may still have them. A 304
 * served before the row is looked up would let somebody removed from a client
 * keep reading its files, for as long as their browser held the ETag, and
 * nothing would look wrong from either end.
 *
 * So the order is the rule: authorise, then consider the cache. This checks it
 * statically, because the failure has no symptom to notice.
 */

const ROUTE = readFileSync(
  join(process.cwd(), 'src/app/api/files/[id]/route.ts'),
  'utf8',
);

describe('the attachment route authorises before it answers from cache', () => {
  it('looks the row up under RLS before any 304', () => {
    const lookup = ROUTE.indexOf('await withUser(');
    const notModified = ROUTE.indexOf('if-none-match');

    expect(lookup, 'the route no longer reads the row through withUser').toBeGreaterThan(-1);
    expect(notModified, 'the route no longer handles If-None-Match').toBeGreaterThan(-1);
    expect(
      lookup,
      'If-None-Match is answered before the row is looked up: a 304 would be served ' +
        'to someone who has lost access to the file',
    ).toBeLessThan(notModified);
  });

  it('refuses a missing or hidden row before any 304', () => {
    // Same rule, the other half: `record` must have been proved to exist.
    const refusal = ROUTE.indexOf('if (!record)');
    const notModified = ROUTE.indexOf('if-none-match');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(notModified);
  });

  it('keeps the cache private and never shared', () => {
    // `public` here would let a proxy between Agadir and this server hold a
    // client's file and hand it to the next person who asked.
    const headers = [...ROUTE.matchAll(/'Cache-Control': '([^']+)'/g)].map((m) => m[1]!);
    expect(headers.length).toBeGreaterThan(0);
    for (const value of headers) {
      expect(value).toContain('private');
      expect(value).not.toContain('public');
    }
  });

  /*
   * This used to assert `attachment;` for every file, full stop. That was
   * deliberately relaxed, and the reason is written down rather than left as
   * a deleted line: `attachment` is not only a hardening measure, it is also
   * the header that told the browser to put a posted photograph in the
   * downloads folder and show the reader nothing at all.
   *
   * What replaces it is narrower, not weaker — the allowlist below, plus the
   * sandbox and nosniff headers that are what actually make inline safe. The
   * types that make inline dangerous, SVG and HTML, cannot be stored in the
   * first place and are asserted out of the list in `uploads.test.ts`.
   */
  it('never renders an unknown type inline', () => {
    expect(ROUTE).toContain("'X-Content-Type-Options': 'nosniff'");
    // No unconditional inline: the disposition must be a decision.
    expect(ROUTE).not.toMatch(/'Content-Disposition': `inline;/);
  });
});

/**
 * Inline is a decision, not a default.
 *
 * Every attachment used to go out as `Content-Disposition: attachment`, and
 * the cost of that was invisible from the server's side: the bytes were served
 * correctly every time, and the reader got a downloads-folder entry instead of
 * a photograph in the conversation.
 *
 * The fix hands the decision to one narrow allowlist. Both halves of that need
 * guarding — that the route consults the list at all, and that it does not
 * quietly become "inline for everything", which would be the same class of
 * mistake in the other and more dangerous direction.
 */
describe('the attachment route decides disposition from the allowlist', () => {
  it('asks servedInline rather than hardcoding either answer', () => {
    expect(ROUTE).toContain('servedInline(record.mimeType)');
    expect(ROUTE).toMatch(/Content-Disposition/);
    // Both outcomes must still exist in the route.
    expect(ROUTE).toContain("'inline'");
    expect(ROUTE).toContain("'attachment'");
  });

  it('keeps the two headers that make inline safe', () => {
    // An opaque origin with no script, and no re-interpreting the bytes as a
    // more interesting type than the one we declared. Serving inline without
    // these is the version of this change that would be a mistake.
    expect(ROUTE).toContain("default-src 'none'; sandbox");
    expect(ROUTE).toContain("'X-Content-Type-Options': 'nosniff'");
  });
});

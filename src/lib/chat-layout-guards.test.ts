import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chat needs a definite height. A minimum is not a height.
 *
 * `min-h-screen` lets a page grow to fit its content. Every other screen in
 * this application wants that — they are documents. Chat is not: the message
 * river scrolls inside itself and the composer stays on the bottom edge, and
 * both of those need a parent whose height is DECIDED, because `overflow-y:
 * auto` on a child of a box that grows has nothing to scroll against.
 *
 * With a minimum it looked fine on a desktop and was broken on a phone:
 * measured at 375px, the document was 6,510 pixels tall and the composer sat
 * at 6,492 — so writing a message meant scrolling past every message already
 * in the channel. It is the kind of fault that a screenshot of the top of the
 * page does not show.
 *
 * The two `dvh` units matter for the same reason. On a phone `100vh` is the
 * viewport WITHOUT the browser's own chrome, so anything pinned to the bottom
 * of `100vh` sits just below the fold.
 */

const SHELL = readFileSync(
  join(process.cwd(), 'src/app/(app)/Shell.tsx'),
  'utf8',
);

/** The class string chat gets, as opposed to the one documents get. */
function roomyClasses(): string {
  const at = SHELL.indexOf('roomy ?');
  expect(at, 'Shell no longer distinguishes chat from a document page').toBeGreaterThan(-1);
  return SHELL.slice(at, at + 200);
}

describe('the chat shell is given a height, not a minimum', () => {
  it('sizes the chat page definitely', () => {
    const classes = roomyClasses();
    expect(
      /h-\[100dvh\]|h-screen/.test(classes),
      'chat is no longer given a definite height, so the message river has ' +
        'nothing to scroll inside and the page will scroll instead',
    ).toBe(true);
  });

  it('does not use a minimum height for chat', () => {
    // `min-h-screen` here is the exact bug: it reads as "at least a screen"
    // and behaves as "as tall as the conversation".
    const classes = roomyClasses();
    const chatBranch = classes.split(':')[1] ?? '';
    expect(
      chatBranch.includes('min-h-'),
      'chat is sized with a minimum again — the composer will sit below the fold',
    ).toBe(false);
  });

  it('measures the phone viewport in dvh', () => {
    // `100vh` on a phone excludes the browser chrome, so a pinned composer
    // ends up underneath it.
    expect(SHELL).toContain('h-[100dvh]');
  });

  it('keeps document pages growing', () => {
    // The other half: a report or a client list SHOULD be as tall as it is.
    expect(SHELL).toContain('min-h-screen');
  });

  it('leaves the phone menu as a drawer, not a sideways scroll', () => {
    // It was a strip holding all eighteen destinations, scrolled sideways,
    // with the account link past the end where nobody found it.
    expect(SHELL).toContain('aria-label={menuOpen ? \'Close menu\' : \'Open menu\'}');
    expect(
      /overflow-x-auto[^"]*md:hidden|md:hidden[^"]*overflow-x-auto/.test(SHELL),
      'the phone navigation scrolls sideways again',
    ).toBe(false);
  });
});

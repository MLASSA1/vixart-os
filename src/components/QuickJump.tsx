'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Jump to any screen by typing part of its name.
 *
 * WHY THIS EXISTS. An administrator's sidebar is twenty-one destinations in
 * five groups. That list is honest — every entry is a real screen somebody
 * uses — but past about a dozen a sidebar stops being navigation and becomes
 * reading: you scan the whole column for "Quotes & invoices" instead of going
 * there. Shortening the list would mean hiding screens behind a "more", which
 * trades a scan for a guess.
 *
 * So the list stays complete, and this gives a second way in for the person who
 * already knows where they are going. Typing "inv" reaches Quotes & invoices in
 * three keys from anywhere, including from inside a document.
 *
 * SCOPE, STATED HONESTLY: this searches SCREENS, not records. It will not find
 * a client by name — that is the next thing it should do, and doing it properly
 * means an endpoint that searches under the asking person's own row level
 * security, not a list of every company shipped to the browser. A jump box that
 * quietly revealed client names to a member would be a hole in the boundary the
 * rest of this application is built to hold.
 */

export interface JumpItem {
  href: string;
  label: string;
  group?: string;
}

/**
 * Match on the label, a word inside it, or the path.
 *
 * Deliberately not fuzzy. A fuzzy matcher scores "Services" against "sch" and
 * puts it above "Schedule"; on a list this size, plain substring matching is
 * both predictable and always right, and predictable is what lets somebody
 * type three letters and hit Enter without looking.
 */
function rank(item: JumpItem, q: string): number {
  const label = item.label.toLowerCase();
  const href = item.href.toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  // A word inside the label: "invoices" in "Quotes & invoices".
  if (label.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 2;
  if (label.includes(q)) return 3;
  if (href.includes(q)) return 4;
  return -1;
}

export function QuickJump({ items }: { items: JumpItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items
      .map((item) => ({ item, score: rank(item, q) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((r) => r.item);
  }, [items, query]);

  /*
   * Cmd+K on a Mac, Ctrl+K elsewhere.
   *
   * Ignored while the person is typing into a field, so that Ctrl+K inside the
   * chat composer or a client's notes still belongs to the field it was typed
   * in. The shortcut is a convenience; stealing a keystroke from somebody
   * mid-sentence is not.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (typing && !open) return;
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
        return;
      }
      if (event.key === 'Escape' && open) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    // The field is the whole point of opening it.
    const id = window.setTimeout(() => inputRef.current?.focus(), 10);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(id);
      document.body.style.overflow = previous;
    };
  }, [open]);

  function go(item: JumpItem | undefined) {
    if (!item) return;
    setOpen(false);
    router.push(item.href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 flex w-full items-center justify-between rounded-lg bg-pure/[0.07] px-3 py-2 text-[13.5px] text-pure/55 transition-colors hover:bg-pure/[0.12] hover:text-pure/80"
      >
        <span className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none"
               stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          Jump to…
        </span>
        {/*
          The hint is hidden from screen readers: "Command K" read aloud in the
          middle of a button called "Jump to" is noise to somebody who is not
          looking at a keyboard shortcut.
        */}
        <span
          aria-hidden="true"
          /*
            Hidden on a phone, which has no ⌘ key. The drawer uses this same
            button, and advertising a shortcut that cannot be typed there is
            how an interface teaches somebody not to trust what it says.
          */
          className="hidden text-[11.5px] tracking-wide text-pure/55 md:inline"
        >
          ⌘K
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-night/75 px-4 pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Jump to a screen"
            /*
              `text-void` is not decoration — it is the fix for a real defect.
              This dialog is rendered from inside the sidebar, which is the one
              dark surface in the application and sets `text-pure` on itself.
              `position: fixed` takes the panel out of the sidebar's LAYOUT but
              not out of its INHERITANCE, so the panel drew white text on a
              white card: the typed query, the placeholder and every result
              except the highlighted one were invisible. A colour is stated
              here so the panel never depends on where it is mounted.
            */
            className="w-full max-w-lg overflow-hidden rounded-[14px] border border-void/10 bg-surface text-void shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCursor((c) => Math.min(c + 1, results.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  go(results[cursor]);
                }
              }}
              placeholder="Go to…"
              aria-label="Search screens"
              className="w-full border-0 border-b border-void/10 bg-transparent px-4 py-3.5 text-[15px] outline-none"
            />

            <ul className="max-h-[52vh] overflow-y-auto py-1">
              {results.length === 0 && (
                <li className="px-4 py-6 text-center">
                  <span className="hint">No screen by that name.</span>
                </li>
              )}
              {results.map((item, index) => (
                <li key={item.href}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => go(item)}
                    className={`flex w-full items-baseline justify-between gap-4 px-4 py-2.5 text-left text-[14.5px] ${
                      index === cursor ? 'bg-accent text-pure' : ''
                    }`}
                  >
                    <span className={index === cursor ? 'font-semibold' : ''}>{item.label}</span>
                    <span
                      className={`text-[12px] ${
                        index === cursor ? 'text-pure/90' : 'text-void/55'
                      }`}
                    >
                      {item.group ?? 'Main'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

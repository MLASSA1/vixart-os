'use client';

import { useEffect, useState } from 'react';

/**
 * A search box for any list on the page, filtering as you type.
 *
 * Before this, three screens of thirty-two could be searched — Leads, Clients
 * and Directory — and Tasks, with 152 rows in production, could only be
 * scrolled. This is the same box on every list, in the same place: above it.
 *
 * It filters what is already on the screen rather than asking the server
 * again, so it is instant and needs nothing from the page but a wrapper with
 * an id. Rows are `[data-row]`, table rows, or list items inside that wrapper.
 * A wrapper marked `data-filter-group` (a section of the list) disappears when
 * none of its rows match, so a search never leaves empty headings behind.
 *
 * Matching ignores case and accents, so "eclat" finds "Éclat" and "cafe"
 * finds "Café" — client and project names here are French as often as not.
 */

const ROWS = '[data-row], tbody > tr, ul > li';

/** Lower case, accents removed, spaces collapsed. */
function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function ListFilter({
  scope,
  placeholder,
}: {
  /** The id of the element that holds the list. */
  scope: string;
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState<{ shown: number; total: number } | null>(null);

  useEffect(() => {
    const root = document.getElementById(scope);
    if (!root) return;

    /*
     * OUTERMOST rows only. A service carries a small list of its price
     * versions, a team member a list of roles; treating those inner items as
     * rows would hide a service's price history while the service itself
     * matched. A row inside another row belongs to it.
     */
    const topRows = () =>
      [...root.querySelectorAll<HTMLElement>(ROWS)].filter((row) => {
        const outer = row.parentElement?.closest(ROWS);
        return !outer || !root.contains(outer);
      });

    const apply = () => {
      const needle = plain(query);
      const rows = topRows();
      let shown = 0;
      for (const row of rows) {
        const hit = !needle || plain(row.textContent ?? '').includes(needle);
        row.hidden = !hit;
        if (hit) shown += 1;
      }
      for (const group of root.querySelectorAll<HTMLElement>('[data-filter-group]')) {
        const any = rows.some((r) => group.contains(r) && !r.hidden);
        group.hidden = Boolean(needle) && !any;
      }
      setCount(needle ? { shown, total: rows.length } : null);
    };

    apply();
    /*
     * Lists here refresh themselves — a task moves, a poll brings a new row.
     * A row React adds after the search would otherwise appear unfiltered, so
     * the filter re-applies whenever the list changes underneath it.
     */
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [query, scope]);

  return (
    // Sized for a Section's header row, where it sits on every list: the same
    // place, on the bar that names the list it searches.
    <div className="flex items-center gap-3">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-controls={scope}
        // An inline width, because `.input` sets `width: 100%` outside Tailwind's
        // layers and so beats any `w-` class — which stretched this box across the
        // title bar it is meant to sit at the end of.
        className="input mt-0 py-1.5 text-[14px]"
        style={{ width: '15rem', maxWidth: '100%' }}
      />
      {count && (
        <span className="hint" aria-live="polite">
          {count.shown === 0 ? 'No match' : `${count.shown} of ${count.total}`}
        </span>
      )}
    </div>
  );
}

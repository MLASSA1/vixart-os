'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Two panes on a desktop, one at a time on a phone.
 *
 * At 375px the channel list and the message river were side by side, which
 * left the messages about 135 pixels wide — one or two characters a line, down
 * the screen. The conversation was legible in the sense that the letters were
 * all present.
 *
 * So on a phone the list becomes a drawer over the conversation, and the
 * conversation gets the whole screen. Nothing about the desktop changes, and
 * no URL does either: the same `/chat/[id]` is one pane or two depending on
 * how much room there is.
 *
 * The toggle lives in the thread's own header rather than in a strip of its
 * own — a phone already spends 56 pixels on the application bar and 48 on the
 * channel name, and a third bar to hold one button would push the first
 * message most of the way down the screen.
 */

interface Drawer {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DrawerContext = createContext<Drawer>({ open: false, setOpen: () => {} });

/** The control that opens the channel list. Phone only — see `md:hidden`. */
export function ChannelsButton() {
  const { setOpen } = useContext(DrawerContext);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Channels and conversations"
      // 44px square: a thumb, not a cursor.
      className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-void/70 md:hidden"
    >
      {/*
        A sidebar-toggle glyph, deliberately NOT a second hamburger: the
        application menu is already a hamburger in the bar directly above, and
        two identical controls a centimetre apart that open different things is
        how somebody ends up on the Dashboard when they wanted a channel.
      */}
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
           stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
        <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
      </svg>
    </button>
  );
}

export function ChatShell({
  list,
  children,
}: {
  /** The channel list. A column on a desktop, a drawer on a phone. */
  list: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Choosing a channel is the point of opening it. Close behind the choice.
  useEffect(() => setOpen(false), [pathname]);

  // Escape closes it, because a drawer with no way out on a keyboard is a trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <DrawerContext.Provider value={{ open, setOpen }}>
      <div className="flex min-h-0 flex-1">
        {/*
          One element, two behaviours. A second copy for the phone would be a
          second channel list free to disagree with the first — and the unread
          counts are exactly the thing that would drift.
        */}
        <div
          // `top-14` on a phone: the application bar stays reachable above the
          // drawer rather than being covered by it.
          className={`fixed top-14 bottom-0 left-0 z-20 w-[82vw] max-w-xs transform shadow-xl transition-transform duration-200 md:static md:top-auto md:bottom-auto md:z-auto md:w-auto md:max-w-none md:transform-none md:shadow-none ${
            open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          }`}
        >
          {list}
        </div>

        {open && (
          <button
            type="button"
            aria-label="Close channels"
            onClick={() => setOpen(false)}
            className="fixed inset-x-0 top-14 bottom-0 z-10 bg-void/40 md:hidden"
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </DrawerContext.Provider>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { signOutAction } from './actions';
import { homeFor } from '@/lib/home';

interface NavItem {
  href: string;
  label: string;
  group?: string;
  minRole?: 'admin' | 'moderator';
}

/**
 * Navigation only ever lists what exists. Modules arrive with their step —
 * no greyed-out entries pointing at screens that are not built.
 */
const NAV: NavItem[] = [
  /*
   * Chat first, for everybody, always. Amin's instruction in those words, and
   * it is the right one: this is the thing the team opens twenty times a day,
   * and it was eighteenth in the list behind sections most of them cannot use.
   */
  { href: '/chat', label: 'Chat' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/attention', label: 'Needs attention' },
  { href: '/my-work', label: 'My work' },

  /*
   * THE TEAM SPACE.
   *
   * What everybody has. Asked for as "move all to team space zone that have
   * tasks schedule prep notes and all features for them" — so this group is the
   * whole of the application for six of the eight people here, and it holds
   * their work and nothing about the company's commerce.
   */
  { href: '/tasks', label: 'Tasks', group: 'Team space' },
  // A person's own week. Moderators can also see the team's, tasks only.
  { href: '/schedule', label: 'Schedule', group: 'Team space' },
  // Where work is thought about before it is assigned. Belongs to whoever is
  // doing the thinking.
  { href: '/prep', label: 'Prep', group: 'Team space' },
  // Private to each person. No moderator or admin view exists, by design.
  { href: '/notes', label: 'Notes', group: 'Team space' },
  { href: '/equipment', label: 'Equipment', group: 'Team space' },
  { href: '/team', label: 'Team', group: 'Team space' },

  /*
   * MANAGEMENT ONLY — Amin and Mohamed Amine.
   *
   * `minRole: 'moderator'` is admin-or-moderator, which is exactly those two
   * and has been since 0006. Everything below this line is the company's
   * commercial business: who the clients are, what is being sold, what it costs
   * and what has been billed.
   *
   * The nav is not what closes them. Every one of these pages lives inside the
   * `(management)` route group, whose layout sends a member to their own work —
   * so a typed url and a stale bookmark get the same answer as a hidden link.
   */
  { href: '/dashboard', label: 'Dashboard', minRole: 'moderator' },

  { href: '/clients', label: 'Clients', group: 'Relationships', minRole: 'moderator' },
  { href: '/leads', label: 'Leads', group: 'Relationships', minRole: 'moderator' },
  { href: '/companies', label: 'All clients', group: 'Relationships', minRole: 'moderator' },

  { href: '/projects', label: 'Projects', group: 'Commerce', minRole: 'moderator' },
  { href: '/deals', label: 'Deals', group: 'Commerce', minRole: 'moderator' },
  // The monthly contracts. Beside Deals because it is where a deal goes when it
  // stops being a one-off.
  { href: '/retainers', label: 'Retainers', group: 'Commerce', minRole: 'moderator' },
  // The price list. Not on Amin's list, and moved anyway: leaving every
  // service's price in MAD one click from a member while Finance is closed
  // would be a boundary that only looks like one.
  { href: '/services', label: 'Services', group: 'Commerce', minRole: 'moderator' },
  { href: '/documents', label: 'Quotes & invoices', group: 'Commerce', minRole: 'admin' },
  { href: '/finance', label: 'Finance', group: 'Commerce', minRole: 'admin' },

  { href: '/client-portal', label: 'Client portal', group: 'Agency', minRole: 'moderator' },
  { href: '/system', label: 'System', group: 'Agency', minRole: 'admin' },
];


/** Nav order, grouped. Modules appear as they are built — nothing dead here. */
const GROUPS = [undefined, 'Team space', 'Relationships', 'Commerce', 'Agency'] as const;

function visible(item: NavItem, role: 'admin' | 'moderator' | 'member') {
  if (item.minRole === 'admin') return role === 'admin';
  if (item.minRole === 'moderator') return role === 'admin' || role === 'moderator';
  return true;
}

/**
 * The sidebar is the one dark surface in the app — warm ink against the paper
 * content, with the saffron accent marking exactly two things: the brand tick
 * and wherever you are. Everything else on it stays quiet.
 */
export function Shell({
  user,
  urgent,
  unread,
  children,
}: {
  user: { name: string; jobTitle: string | null; role: 'admin' | 'moderator' | 'member' };
  /** How many things are waiting on this person right now. */
  urgent: number;
  /** Unread notifications addressed to this person. */
  unread: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const items = NAV.filter((i) => visible(i, user.role));
  /*
   * Where the wordmark goes.
   *
   * It pointed at /dashboard, which a member can no longer open — so for them
   * the one thing on every screen that looks like "home" would have bounced
   * them somewhere else. Their home is their work.
   */
  const home = homeFor(user.role);
  /**
   * The mobile menu.
   *
   * It was a horizontal strip holding all eighteen destinations, which meant
   * reaching Chat or Team was a long sideways scrag through a bar two
   * centimetres tall, and the account link sat past the end of it where nobody
   * would find it. A phone gets a title bar and a drawer, with the same groups
   * the sidebar uses.
   */
  const [menuOpen, setMenuOpen] = useState(false);

  // Following a link should close it. The drawer is not a place to be.
  useEffect(() => setMenuOpen(false), [pathname]);

  // A drawer over the page must not leave the page scrolling underneath it.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);
  /**
   * Chat fills the pane instead of sitting in the reading column. Every other
   * screen is a document and wants the measure; a channel list and a message
   * river want the room, and want to scroll inside themselves rather than
   * moving the page.
   */
  const roomy = pathname === '/chat' || pathname.startsWith('/chat/');

  return (
    /*
      Chat needs a DEFINITE height, not a minimum.
      `min-h-screen` lets the page grow to fit its content, so the message
      river never gets a bounded box to scroll inside and the whole document
      scrolls instead — on a phone that put the composer 6,500 pixels down a
      channel, so writing a message meant scrolling past every message already
      in it. Every other screen is a document and should grow.
    */
    <div className={roomy ? 'flex h-[100dvh] overflow-hidden md:h-screen' : 'flex min-h-screen'}>
      {/* Sidebar — fixed, scrolls independently of the content. */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-void text-pure md:flex">
        <div className="px-6 pt-7 pb-6">
          <Link href={home} className="block">
            <span className="display flex items-baseline gap-2 text-xl font-bold tracking-tight">
              VIXART OS
              {/* The brand tick: the accent's first of two appearances. */}
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[3px] bg-accent" />
            </span>
          </Link>
          <p className="mt-1 text-[12.5px] font-medium text-pure/45">
            SOCIETE VIXART SARL — Agadir
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-1">
          {GROUPS.map((group) => {
            const inGroup = items.filter((i) => i.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group ?? 'main'} className="mb-4">
                {group && (
                  <p className="px-3 pt-3 pb-1.5 text-[11px] font-bold tracking-[0.1em] text-pure/35 uppercase">
                    {group}
                  </p>
                )}
                {inGroup.map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      /* Where you are: the accent's second appearance. */
                      className={`mb-0.5 flex items-center justify-between rounded-lg px-3 py-2 text-[14.5px] transition-colors ${
                        active
                          ? 'bg-accent font-semibold text-pure'
                          : 'text-pure/80 hover:bg-pure/10 hover:text-pure'
                      }`}
                    >
                      {item.label}
                      {item.href === '/inbox' && unread > 0 && (
                        <span
                          className={`ml-2 inline-block min-w-[1.4rem] rounded-full px-1.5 py-px text-center text-[12px] font-bold ${
                            active ? 'bg-pure text-accent-deep' : 'bg-accent text-pure'
                          }`}
                        >
                          {unread}
                        </span>
                      )}
                      {item.href === '/attention' && urgent > 0 && (
                        <span
                          className={`ml-2 inline-block min-w-[1.4rem] rounded-full px-1.5 py-px text-center text-[12px] font-bold ${
                            active ? 'bg-pure text-accent-deep' : 'bg-accent text-pure'
                          }`}
                        >
                          {urgent}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* The person, in a quiet inset card. */}
        <div className="px-4 pt-2 pb-5">
          <div className="rounded-xl bg-pure/[0.07] px-4 py-4">
            <p className="leading-tight font-semibold">{user.name}</p>
            <p className="mt-0.5 text-[12.5px] text-pure/50">
              {user.role === 'admin'
                ? 'Management'
                : user.role === 'moderator'
                  ? 'Work moderator'
                  : (user.jobTitle ?? 'Team')}
            </p>
            <div className="mt-3 flex items-center gap-4 text-[13px]">
              <Link
                href="/account"
                className="text-pure/70 underline-offset-4 hover:text-pure hover:underline"
              >
                My account
              </Link>
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="cursor-pointer text-pure/70 underline-offset-4 hover:text-pure hover:underline"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>

      {/* --- Phone: a title bar, and a drawer behind it ---------------------- */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-pure/10 bg-void px-3 text-pure md:hidden">
        <Link href={home} className="display px-1 text-[17px] font-bold whitespace-nowrap">
          VIXART
          <span aria-hidden="true" className="ml-1 inline-block h-2 w-2 rounded-[2px] bg-accent" />
        </Link>

        <div className="flex items-center gap-1">
          {/* The two counts worth seeing without opening anything. */}
          {unread > 0 && (
            <Link
              href="/inbox"
              className="rounded-md px-2 py-1 text-[13px] text-pure/80"
              aria-label={`Inbox, ${unread} unread`}
            >
              Inbox <span className="font-semibold text-pure">{unread}</span>
            </Link>
          )}
          {urgent > 0 && (
            <Link
              href="/attention"
              className="rounded-md bg-accent px-2 py-1 text-[13px] font-semibold text-pure"
              aria-label={`Needs attention, ${urgent} waiting`}
            >
              {urgent}
            </Link>
          )}

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            // 44px: a thumb, not a cursor.
            className="flex h-11 w-11 items-center justify-center rounded-md text-pure"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {menuOpen ? (
                <>
                  <line x1="5" y1="5" x2="19" y2="19" />
                  <line x1="19" y1="5" x2="5" y2="19" />
                </>
              ) : (
                <>
                  <line x1="3.5" y1="7" x2="20.5" y2="7" />
                  <line x1="3.5" y1="12" x2="20.5" y2="12" />
                  <line x1="3.5" y1="17" x2="20.5" y2="17" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 top-14 z-30 flex flex-col bg-void text-pure md:hidden">
          <nav className="flex-1 overflow-y-auto px-3 py-3">
            {GROUPS.map((group) => {
              const inGroup = items.filter((i) => i.group === group);
              if (inGroup.length === 0) return null;
              return (
                <div key={group ?? 'top'} className="mb-4">
                  {group && (
                    // Not the `.label` utility: it sets an ink colour, which is
                    // invisible on this dark surface. Same treatment as the
                    // sidebar's group headings above.
                    <p className="px-3 pt-3 pb-1.5 text-[11px] font-bold tracking-[0.1em] text-pure/35 uppercase">
                      {group}
                    </p>
                  )}
                  {inGroup.map((item) => {
                    const active =
                      pathname === item.href || pathname.startsWith(`${item.href}/`);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`flex items-center justify-between rounded-md px-3 py-3 text-[15px] ${
                          active ? 'bg-accent font-semibold text-pure' : 'text-pure/80'
                        }`}
                      >
                        <span>{item.label}</span>
                        {item.href === '/inbox' && unread > 0 && (
                          <span className="text-[13px] text-pure/70">{unread}</span>
                        )}
                        {item.href === '/attention' && urgent > 0 && (
                          <span className="text-[13px] text-pure/70">{urgent}</span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          <div className="border-t border-pure/10 px-5 py-4">
            <p className="font-semibold">{user.name}</p>
            {user.jobTitle && <p className="text-[13px] text-pure/60">{user.jobTitle}</p>}
            <div className="mt-3 flex items-center gap-4">
              <Link href="/account" className="text-[14px] underline underline-offset-4">
                My account
              </Link>
              <form action={signOutAction}>
                <button type="submit" className="text-[14px] text-pure/70 underline underline-offset-4">
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/*
        `dvh` above rather than `vh`: on a phone `100vh` is the viewport WITHOUT
        the browser's own chrome, so a composer pinned to the bottom sits just
        below the fold.
      */}
      {roomy ? (
        <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden pt-14 md:pt-0">
          {children}
        </main>
      ) : (
        <main className="min-w-0 flex-1 px-6 pt-20 pb-24 md:px-10 md:pt-10">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
      )}
    </div>
  );
}

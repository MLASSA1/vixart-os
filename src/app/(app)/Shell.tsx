'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { signOutAction } from './actions';

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
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/attention', label: 'Needs attention' },
  { href: '/my-work', label: 'My work' },
  { href: '/clients', label: 'Clients', group: 'Relationships' },
  { href: '/leads', label: 'Leads', group: 'Relationships' },
  { href: '/companies', label: 'All clients', group: 'Relationships' },
  { href: '/deals', label: 'Deals', group: 'Work', minRole: 'moderator' },
  { href: '/projects', label: 'Projects', group: 'Work' },
  { href: '/services', label: 'Services', group: 'Work' },
  { href: '/documents', label: 'Quotes & invoices', group: 'Work', minRole: 'admin' },
  { href: '/finance', label: 'Finance', group: 'Work', minRole: 'admin' },
  { href: '/team', label: 'Team', group: 'Agency' },
  { href: '/equipment', label: 'Equipment', group: 'Agency' },
  { href: '/system', label: 'System', group: 'Agency', minRole: 'admin' },
];

/** Nav order, grouped. Modules appear as they are built — nothing dead here. */
const GROUPS = [undefined, 'Relationships', 'Work', 'Agency'] as const;

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
  children,
}: {
  user: { name: string; jobTitle: string | null; role: 'admin' | 'moderator' | 'member' };
  /** How many things are waiting on this person right now. */
  urgent: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const items = NAV.filter((i) => visible(i, user.role));

  return (
    <div className="flex min-h-screen">
      {/* Sidebar — fixed, scrolls independently of the content. */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-void text-pure md:flex">
        <div className="px-6 pt-7 pb-6">
          <Link href="/dashboard" className="block">
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

      {/* Mobile bar — the sidebar collapses to a dark horizontal strip. */}
      <div className="fixed inset-x-0 top-0 z-10 flex items-center gap-1 overflow-x-auto bg-void px-3 py-2.5 text-pure md:hidden">
        <Link href="/dashboard" className="display px-2 font-bold whitespace-nowrap">
          VIXART
          <span aria-hidden="true" className="ml-1 inline-block h-2 w-2 rounded-[2px] bg-accent" />
        </Link>
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-2.5 py-1 text-[13px] whitespace-nowrap ${
                active ? 'bg-accent font-semibold text-pure' : 'text-pure/75'
              }`}
            >
              {item.label}
              {item.href === '/attention' && urgent > 0 && ` (${urgent})`}
            </Link>
          );
        })}
        <Link href="/account" className="ml-auto px-2 text-[13px] whitespace-nowrap text-pure/75">
          {user.name}
        </Link>
      </div>

      <main className="min-w-0 flex-1 px-6 pt-20 pb-24 md:px-10 md:pt-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

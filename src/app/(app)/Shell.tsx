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

export function Shell({
  user,
  children,
}: {
  user: { name: string; jobTitle: string | null; role: 'admin' | 'moderator' | 'member' };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const items = NAV.filter((i) => visible(i, user.role));

  return (
    <div className="flex min-h-screen">
      {/* Sidebar — fixed, scrolls independently of the content. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-void md:flex">
        <div className="border-b border-void px-6 py-6">
          <Link href="/dashboard" className="block">
            <span className="text-xl font-bold tracking-tight">VIXART OS</span>
          </Link>
          <p className="label mt-1" style={{ opacity: 0.52 }}>
            Agadir
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto py-3">
          {GROUPS.map((group) => {
            const inGroup = items.filter((i) => i.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group ?? 'main'} className="mb-3">
                {group && (
                  <p className="label px-6 pt-3 pb-1 text-[11.5px] tracking-wide uppercase opacity-60">
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
                      /* Active state: solid inversion. Never a colour. */
                      className={`block px-6 py-2 text-[14.5px] ${
                        active
                          ? 'bg-void font-medium text-pure'
                          : 'hover:bg-void hover:text-pure'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-void px-6 py-5">
          <p className="font-semibold leading-tight">{user.name}</p>
          <p className="label mt-0.5" style={{ opacity: 0.52 }}>
            {user.role === 'admin'
              ? 'Management'
              : user.role === 'moderator'
                ? 'Work moderator'
                : (user.jobTitle ?? 'Team')}
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <Link href="/account" className="label underline underline-offset-4">
              My account
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="label cursor-pointer underline underline-offset-4"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Mobile bar — the sidebar collapses to a horizontal strip. */}
      <div className="fixed inset-x-0 top-0 z-10 flex items-center gap-4 overflow-x-auto border-b border-void bg-pure px-4 py-3 md:hidden">
        <Link href="/dashboard" className="font-bold whitespace-nowrap">
          VIXART OS
        </Link>
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`label whitespace-nowrap px-2 py-1 ${
                active ? 'bg-void text-pure' : ''
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <Link href="/account" className="label ml-auto whitespace-nowrap">
          {user.name}
        </Link>
      </div>

      <main className="min-w-0 flex-1 px-6 pt-20 pb-24 md:px-10 md:pt-12">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

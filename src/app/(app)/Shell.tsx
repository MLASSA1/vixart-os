'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { signOutAction } from './actions';

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

/**
 * Navigation only ever lists what exists. Modules arrive with their step —
 * no greyed-out entries pointing at screens that are not built.
 */
const NAV: NavItem[] = [
  { href: '/clients', label: 'Clients' },
  { href: '/team', label: 'Team' },
  { href: '/system', label: 'System', adminOnly: true },
];

export function Shell({
  user,
  children,
}: {
  user: { name: string; jobTitle: string | null; role: 'admin' | 'member' };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const items = NAV.filter((i) => !i.adminOnly || user.role === 'admin');

  return (
    <div className="flex min-h-screen">
      {/* Sidebar — fixed, scrolls independently of the content. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-void md:flex">
        <div className="border-b border-void px-6 py-6">
          <Link href="/clients" className="block">
            <span className="text-xl font-bold tracking-tight">VIXART OS</span>
          </Link>
          <p className="meta mt-1" style={{ opacity: 0.52 }}>
            Agadir
          </p>
        </div>

        <nav className="flex-1 py-4">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                /* Active state: solid inversion. Never a colour. */
                className={`meta block px-6 py-3 ${
                  active ? 'bg-void text-pure' : 'hover:bg-void hover:text-pure'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-void px-6 py-5">
          <p className="font-semibold leading-tight">{user.name}</p>
          <p className="meta mt-0.5" style={{ opacity: 0.52 }}>
            {user.role === 'admin' ? 'Management' : (user.jobTitle ?? 'Team')}
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <Link href="/account" className="meta underline underline-offset-4">
              My account
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="meta cursor-pointer underline underline-offset-4"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Mobile bar — the sidebar collapses to a horizontal strip. */}
      <div className="fixed inset-x-0 top-0 z-10 flex items-center gap-4 overflow-x-auto border-b border-void bg-pure px-4 py-3 md:hidden">
        <Link href="/clients" className="font-bold whitespace-nowrap">
          VIXART OS
        </Link>
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`meta whitespace-nowrap px-2 py-1 ${
                active ? 'bg-void text-pure' : ''
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <Link href="/account" className="meta ml-auto whitespace-nowrap">
          {user.name}
        </Link>
      </div>

      <main className="min-w-0 flex-1 px-6 pt-20 pb-24 md:px-10 md:pt-12">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

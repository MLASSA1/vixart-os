'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const PORTAL_NAV = [
  { href: '/portal', label: 'Overview' },
  { href: '/portal/billing', label: 'Invoices & payments' },
  { href: '/portal/support', label: 'Messages' },
  { href: '/portal/systems', label: 'What we build' },
  { href: '/portal/account', label: 'Account' },
] as const;

/**
 * The portal's navigation, with the current page marked.
 *
 * Without the mark, every page looked like the start page with different
 * words on it. `/portal` is matched exactly — it is a prefix of everything —
 * and a project page counts as the overview, which is where it is reached from.
 */
export function PortalNav({ unread }: { unread: number }) {
  const pathname = usePathname();
  const on = (href: string) =>
    href === '/portal'
      ? pathname === '/portal' || pathname.startsWith('/portal/projects')
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {PORTAL_NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={on(item.href) ? 'page' : undefined}
          className={`vix-meta px-3 py-3.5 whitespace-nowrap hover:text-white ${on(item.href) ? 'vix-nav-on' : ''}`}
        >
          {item.label}
          {item.href === '/portal/support' && unread > 0 && !on(item.href) && (
            <span className="vix-tag vix-tag-strong ml-2 !mt-0 !px-1.5 !py-0" aria-label={`${unread} unread`}>
              {unread}
            </span>
          )}
        </Link>
      ))}
    </>
  );
}

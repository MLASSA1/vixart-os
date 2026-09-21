import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { signOutAction } from '@/app/(app)/actions';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/portal', label: 'Your work' },
  { href: '/portal/systems', label: 'What we build' },
  { href: '/portal/support', label: 'Talk to us' },
  { href: '/portal/account', label: 'Account' },
];

/**
 * What a client sees around every page.
 *
 * Four destinations and a name. That is the whole application to them — and
 * it is written here rather than inherited from the staff shell, which has a
 * link to every part of the business in it. A link added there one afternoon
 * must not appear on a client's screen; working or not, it tells them what
 * exists.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  // A staff token reaching the portal is not a client and does not belong
  // here. It cannot happen across containers — different secrets — but this is
  // the page every other portal page sits inside.
  if (!session?.user || session.user.kind !== 'client') redirect('/portal/sign-in');

  const mustChange = session.user.mustChangePassword;

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="vix-rule border-b">
        <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-4 px-6 py-5">
          <Link href="/portal" className="vix-wordmark text-xl">
            VIXART
          </Link>
          <div className="min-w-0 text-right">
            <p className="truncate text-[13.5px] font-semibold">{session.user.companyName}</p>
            <p className="vix-quiet truncate">{session.user.name}</p>
          </div>
        </div>

        {!mustChange && (
          <nav className="vix-rule mx-auto flex max-w-[1100px] items-center gap-1 overflow-x-auto border-t px-4">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="vix-meta px-3 py-3.5 whitespace-nowrap hover:text-white"
              >
                {item.label}
              </Link>
            ))}
            <form action={signOutAction} className="ml-auto">
              <button type="submit" className="vix-meta px-3 py-3.5 whitespace-nowrap hover:text-white">
                Sign out
              </button>
            </form>
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1100px] flex-1 px-6 py-12">{children}</main>

      <footer className="mx-auto w-full max-w-[1100px] px-6 pb-12">
        <div className="vix-rule border-t pt-6">
          <p className="vix-meta">VIXART · Business Growth Engineering™</p>
          <p className="vix-quiet mt-2">
            Agadir Bay, Agadir 80000 · +212 643-953191 · admin@visionxart.com
          </p>
          <p className="vix-quiet mt-1">
            Anything you write here reaches the team directly.
          </p>
        </div>
      </footer>
    </div>
  );
}

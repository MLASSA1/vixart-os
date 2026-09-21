import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { signOutAction } from '@/app/(app)/actions';

export const dynamic = 'force-dynamic';

/**
 * What a client sees around every page.
 *
 * Written from scratch rather than sharing the staff shell. That shell has a
 * link to every part of the business in it, and inheriting it would mean a
 * link added there one afternoon appears on a client's screen — working or
 * not, it tells them what exists.
 *
 * Four destinations, and a name. That is the whole application to them.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  // A staff token reaching the portal is not a client and does not belong
  // here. It cannot happen across containers — different secrets — but this
  // is the page every other portal page sits inside.
  if (!session?.user || session.user.kind !== 'client') redirect('/portal/sign-in');

  const mustChange = session.user.mustChangePassword;

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="border-b border-void/10 bg-void text-pure">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-3">
          <Link href="/portal" className="display text-[17px] font-bold whitespace-nowrap">
            VIXART
            <span aria-hidden="true" className="ml-1.5 inline-block h-2 w-2 rounded-[2px] bg-accent" />
          </Link>
          <div className="min-w-0 text-right">
            <p className="truncate text-[13.5px] font-semibold">{session.user.companyName}</p>
            <p className="truncate text-[12px] text-pure/60">{session.user.name}</p>
          </div>
        </div>

        {!mustChange && (
          <nav className="mx-auto flex max-w-4xl gap-1 px-4 pb-2">
            {[
              { href: '/portal', label: 'Your work' },
              { href: '/portal/support', label: 'Talk to us' },
              { href: '/portal/services', label: 'What we do' },
              { href: '/portal/account', label: 'Account' },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-2 text-[14px] text-pure/80 hover:bg-pure/10"
              >
                {item.label}
              </Link>
            ))}
            <form action={signOutAction} className="ml-auto">
              <button type="submit" className="rounded-md px-3 py-2 text-[14px] text-pure/60">
                Sign out
              </button>
            </form>
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-8">{children}</main>

      <footer className="mx-auto w-full max-w-4xl px-5 pb-10">
        <p className="hint border-t border-void/10 pt-5">
          SOCIETE VIXART SARL — Agadir. Anything you write here reaches the team
          directly.
        </p>
      </footer>
    </div>
  );
}

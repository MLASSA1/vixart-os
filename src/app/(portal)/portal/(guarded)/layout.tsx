import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { signOutAction } from '@/app/(app)/actions';
import { withClient } from '@/db/session';
import { readPortalInbox } from '@/lib/client-portal-queries';
import { PortalNav } from './PortalNav';

export const dynamic = 'force-dynamic';

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

  // Replies they have not opened yet, for the count beside "Messages". A
  // failure here costs the badge, never the page.
  const unread = mustChange
    ? 0
    : await withClient(session.user.id, readPortalInbox).then((i) => i.unread).catch(() => 0);

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
          <nav className="vix-rule mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-1 border-t px-4">
            {/*
              Wraps rather than scrolls. As a sideways-scrolling strip, a phone
              showed three of the five entries and put Account and Sign out past
              the right edge, with a grey native scrollbar as the only sign they
              existed. A client looking for where to change their password would
              not have found it. Two rows on a phone cost 46px; a missing door
              costs a support message.
            */}
            <PortalNav unread={unread} />
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

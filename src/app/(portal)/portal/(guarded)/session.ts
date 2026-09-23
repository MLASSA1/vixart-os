import 'server-only';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';

/**
 * The signed-in client, for a PAGE.
 *
 * `requireClientSession()` throws, which is right for a server action: there
 * is no page to send anybody to and the caller wants an error. In a page it is
 * wrong, and it was wrong in a way that only showed up the next day.
 *
 * The guarded layout already redirects a visitor with no client session — but
 * a layout and the page inside it render CONCURRENTLY. The redirect does not
 * stop the page from running, so the page threw, and Next showed its error
 * screen: "something went wrong, try again". On a fresh request the redirect
 * usually won the race and nobody noticed; on a client-side navigation — a
 * client clicking "Talk to us" after their twelve-hour session had expired —
 * the throw is what they saw.
 *
 * So every page asks through here, and here redirects rather than throws.
 * `redirect()` raises a signal Next understands, which the layout's own
 * redirect agrees with instead of racing.
 */
export async function requireClientPage() {
  const session = await auth();

  if (!session?.user || session.user.kind !== 'client' || !session.user.companyId) {
    redirect('/portal/sign-in');
  }

  return session;
}

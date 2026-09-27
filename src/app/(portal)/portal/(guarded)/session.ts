import 'server-only';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { clientAccountIsLive } from '@/db/session';

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

  /*
   * And the account as it stands NOW, not as it stood when the token was signed.
   *
   * A token lasts twelve hours and carries the company in it, so turning a
   * client's account off — or archiving the company, which is a relationship
   * that has ended — left them reading that company's work until it expired.
   * 0073 closed the data off in `app.current_client_company()`, which is what
   * every client policy is written in terms of.
   *
   * That alone produced a 500 on every page: `withClient` throws when the
   * account is gone, which is correct for a server action and is Next's error
   * screen for a visitor. The access decision was right and what the client saw
   * was "something went wrong" — the same mistake, in the same file's history,
   * as the one the comment above describes.
   */
  if (!(await clientAccountIsLive(session.user.id))) {
    redirect('/portal/sign-in');
  }

  return session;
}

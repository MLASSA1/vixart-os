import { redirect } from 'next/navigation';
import { auth } from '@/auth';

/**
 * The half of the system that is the company's commercial business.
 *
 * Amin asked for this twice in one message, which is how much it mattered: the
 * team should not see the client list, the leads, the projects board, the
 * dashboard, the money, the quotes and invoices, or the retainers. Everything
 * they need — their work, the schedule, prep, notes and the chat — stays where
 * it was.
 *
 * WHY A ROUTE GROUP AND NOT A CHECK ON EACH PAGE.
 *
 * There were twelve sections to close and there will be more. Twelve copies of
 * the same three lines is twelve chances to forget one, and the thirteenth page
 * — written in a hurry, six months from now, by whoever is here — would be open
 * by default. A folder cannot be forgotten: anything inside it is guarded
 * because of where it is, including routes nobody has written yet.
 *
 * `(management)` is a route group, so it changes NO urls. `/finance` is still
 * `/finance`. Nothing anybody has bookmarked moves.
 *
 * This is not the only layer. `deal`, `retainer`, `document` and `finance_entry`
 * are already closed to a member by row level security, and 0069 closes
 * `contact` — so a member could not read those rows even through a page that
 * forgot. What this adds is the earlier and cheaper answer: they never arrive.
 *
 * `company` and `project` stay readable, deliberately. A member's own task says
 * which project and which client it is for, and they have to be able to read
 * that or the task is meaningless. What is closed is the page that lists them
 * ALL — the book of business, rather than the name attached to their work.
 */
export const dynamic = 'force-dynamic';

export default async function ManagementLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const role = session?.user.role;

  /*
   * To their own work, not to the sign-in page.
   *
   * A member who follows an old bookmark to /projects has done nothing wrong
   * and is perfectly entitled to be here — just not there. Sending them
   * somewhere useful is the difference between a boundary and a telling-off.
   */
  if (role !== 'admin' && role !== 'moderator') redirect('/my-work');

  return <>{children}</>;
}

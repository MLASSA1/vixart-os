import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { homeFor } from '@/lib/home';

/**
 * Entry point.
 *
 * Not one destination any more. The dashboard is the company's commercial
 * picture and lives behind `(management)`, so sending a member there would work
 * — the layout would bounce them to their own work — but it would mean the very
 * first thing the application does for six of the eight people here is redirect
 * them out of somewhere they are not allowed. Their home is their work.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  redirect(homeFor(session.user.role));
}

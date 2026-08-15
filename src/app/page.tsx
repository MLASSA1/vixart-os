import { redirect } from 'next/navigation';
import { auth } from '@/auth';

/** Entry point: straight to the pipeline when signed in, otherwise sign-in. */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await auth();
  redirect(session?.user ? '/clients' : '/sign-in');
}

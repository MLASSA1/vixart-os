import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect('/clients');

  const { changed } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <header className="border-b-2 border-void pb-6">
        <p className="label" style={{ opacity: 0.52 }}>
          SOCIETE VIXART SARL — Agadir
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">VIXART OS</h1>
      </header>

      {changed && (
        <p className="label mt-6 border border-void px-4 py-3">
          Password changed — sign in again
        </p>
      )}

      <SignInForm />

      <p className="prose-vixart mt-10 text-[15px]" style={{ opacity: 0.52 }}>
        Internal system. Five accounts, no public sign-up. Contact Amin if you
        cannot get in.
      </p>
    </main>
  );
}

import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { ClientSignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default async function ClientSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  const session = await auth();
  if (session?.user?.kind === 'client') redirect('/portal');
  const { changed } = await searchParams;

  return (
    <main className="flex min-h-[100dvh] flex-col justify-center px-6 py-16">
      <div className="mx-auto w-full max-w-md">
        <p className="display flex items-baseline gap-2.5 text-2xl font-bold tracking-tight">
          VIXART
          <span aria-hidden="true" className="inline-block h-3 w-3 rounded-[3px] bg-accent" />
        </p>
        <p className="hint mt-1">SOCIETE VIXART SARL — Agadir</p>

        <div className="card mt-8 px-6 py-7">
          {changed === '1' && (
            <p role="status" className="tone-ok mb-4 rounded-[10px] px-4 py-3">
              Password changed. Sign in with the new one.
            </p>
          )}
          <h1 className="display text-xl font-bold">Your account</h1>
          <p className="hint mt-1">
            See your projects, follow the work, and write to us.
          </p>
          <ClientSignInForm />
        </div>

        <p className="hint mt-6">
          This is for VIXART clients. If you work at VIXART, sign in at the
          address you normally use. If you have not been given an account and
          would like one, ask us.
        </p>
      </div>
    </main>
  );
}

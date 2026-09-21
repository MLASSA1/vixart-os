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
      <div className="mx-auto w-full max-w-[440px]">
        <p className="vix-wordmark text-2xl">VIXART</p>
        <p className="vix-meta mt-2">Business Growth Engineering™</p>

        <div className="vix-card mt-10 px-7 py-8">
          {changed === '1' && (
            <p role="status" className="vix-alert mb-5">
              Password changed. Sign in with the new one.
            </p>
          )}
          <h1 className="vix-h2">Your account</h1>
          <p className="vix-body mt-2">
            See your projects, follow the work, and write to us.
          </p>
          <ClientSignInForm />
        </div>

        <p className="vix-quiet mt-8">
          For VIXART clients. If you work at VIXART, sign in at the address you
          normally use. If you have not been given an account and would like
          one, ask us.
        </p>
      </div>
    </main>
  );
}

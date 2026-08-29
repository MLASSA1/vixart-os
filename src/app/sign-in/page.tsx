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
    <main className="flex min-h-screen">
      {/* The dark half: the brand, and nothing asking to be clicked. */}
      <section className="hidden flex-1 flex-col justify-between bg-void p-12 text-pure lg:flex">
        <p className="display flex items-baseline gap-2.5 text-2xl font-bold tracking-tight">
          VIXART OS
          <span aria-hidden="true" className="inline-block h-3 w-3 rounded-[3px] bg-accent" />
        </p>
        <div>
          <p className="display max-w-md text-4xl leading-tight font-semibold">
            The agency,
            <br />
            on one screen.
          </p>
          <p className="mt-4 max-w-sm text-[15px] text-pure/55">
            Clients, work, quotes and the books — nothing leaves this machine.
          </p>
        </div>
        <p className="text-[13px] text-pure/40">SOCIETE VIXART SARL — Agadir</p>
      </section>

      {/* The paper half: just the door. */}
      <section className="flex flex-1 flex-col justify-center bg-paper px-6 py-16">
        <div className="mx-auto w-full max-w-sm">
          <header className="lg:hidden">
            <p className="display flex items-baseline gap-2 text-2xl font-bold tracking-tight">
              VIXART OS
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[3px] bg-accent" />
            </p>
            <p className="label mt-1">SOCIETE VIXART SARL — Agadir</p>
          </header>

          <div className="card mt-8 px-7 py-8 lg:mt-0">
            <h1 className="text-xl font-bold tracking-tight">Sign in</h1>

            {changed && (
              <p className="tone-ok mt-4 rounded-[10px] px-4 py-3 text-[14px]">
                Password changed — sign in again
              </p>
            )}

            <SignInForm />
          </div>

          <p className="hint mt-6">
            Internal system. Team accounts only, no public sign-up. Contact Amin if you
            cannot get in.
          </p>
        </div>
      </section>
    </main>
  );
}

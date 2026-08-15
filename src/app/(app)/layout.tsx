import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { PasswordForm } from './PasswordForm';
import { Shell } from './Shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');

  const user = {
    name: session.user.name ?? session.user.email ?? 'Team',
    jobTitle: session.user.jobTitle,
    role: session.user.role,
  };

  /**
   * The seeded accounts share one initial password. Until it is changed the
   * rest of the application stays out of reach — a blocking screen rather than
   * a dismissible reminder, and no route to guess around it.
   */
  if (session.user.mustChangePassword) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <header className="border-b-2 border-void pb-5">
          <p className="meta" style={{ opacity: 0.52 }}>
            {user.name}
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Choose your password
          </h1>
        </header>

        <p className="prose-vixart mt-6" style={{ opacity: 0.68 }}>
          Your account still uses the shared password set when the system was
          installed. Choose your own before going any further — everyone on the
          team currently knows the one you signed in with.
        </p>

        <PasswordForm label="Set password" />
      </main>
    );
  }

  return <Shell user={user}>{children}</Shell>;
}

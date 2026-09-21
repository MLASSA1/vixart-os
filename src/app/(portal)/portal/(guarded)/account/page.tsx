import { requireClientSession } from '@/auth';
import { ClientPasswordForm } from './PasswordForm';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await requireClientSession();
  const first = session.user.mustChangePassword;

  return (
    <>
      <p className="label" style={{ opacity: 0.6 }}>{session.user.companyName}</p>
      <h1 className="display mt-1 text-3xl font-bold tracking-tight">
        {first ? 'Choose your password' : 'Your account'}
      </h1>

      {first ? (
        <p className="prose-vixart mt-3" style={{ opacity: 0.7 }}>
          The password we emailed you works once. Choose your own now — it is
          the only one we will not know.
        </p>
      ) : (
        <p className="prose-vixart mt-3" style={{ opacity: 0.7 }}>
          Signed in as {session.user.email}. You can change your password here.
        </p>
      )}

      <ClientPasswordForm label={first ? 'Set password' : 'Change password'} />

      {!first && (
        <p className="hint mt-10">
          To close this account, or to give somebody else at
          {' '}{session.user.companyName} their own, ask us under “Talk to us”.
        </p>
      )}
    </>
  );
}

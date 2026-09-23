import { requireClientPage } from '../session';
import { ClientPasswordForm } from './PasswordForm';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await requireClientPage();
  const first = session.user.mustChangePassword;

  return (
    <>
      <p className="vix-meta">{session.user.companyName}</p>
      <h1 className="vix-h1 mt-4">
        {first ? 'Choose your password' : 'Your account'}
      </h1>

      <p className="vix-lead mt-5">
        {first
          ? 'The password we emailed you works once. Choose your own now — it is the only one we will not know.'
          : `Signed in as ${session.user.email}. You can change your password here.`}
      </p>

      <ClientPasswordForm label={first ? 'Set password' : 'Change password'} />

      {!first && (
        <p className="vix-quiet vix-rule mt-14 border-t pt-6">
          To close this account, or to give somebody else at{' '}
          {session.user.companyName} their own, ask us under “Talk to us”.
        </p>
      )}
    </>
  );
}

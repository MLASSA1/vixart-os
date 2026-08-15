import { Field, PageHeader } from '@/components/ui';
import { auth } from '@/auth';
import { PasswordForm } from '../PasswordForm';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await auth();
  const user = session!.user;

  return (
    <>
      <PageHeader eyebrow="VIXART OS" title="My account" />

      <div className="max-w-md">
        <Field label="Name" value={user.name} />
        <Field label="Email" value={user.email} />
        <Field label="Role" value={user.jobTitle} />
        <Field label="Access" value={user.role === 'admin' ? 'Management' : 'Team'} />
      </div>

      <section className="mt-12">
        <h2 className="label border-b border-void pb-2">Change password</h2>
        <p className="prose-vixart mt-4" style={{ opacity: 0.68 }}>
          You will be signed out once it is changed, and will sign in again with the
          new password.
        </p>
        <PasswordForm />
      </section>
    </>
  );
}

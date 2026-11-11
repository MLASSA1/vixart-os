import { requireClientPage } from '../session';
import { sql } from 'drizzle-orm';
import { withClient } from '@/db/session';
import { ClientPasswordForm } from './PasswordForm';
import { setReplyEmailsAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await requireClientPage();
  const first = session.user.mustChangePassword;
  const replyEmails = first
    ? true
    : await withClient(session.user.id, async (tx) => {
        const r = await tx.execute<{ on: boolean | null }>(sql`SELECT app.own_reply_emails() AS on`);
        return r.rows[0]?.on !== false;
      });

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
        <section className="vix-card mt-14 px-6 py-6">
          <h2 className="vix-meta">Emails when we reply</h2>
          <p className="vix-body mt-3">
            {replyEmails
              ? `When the team replies to you, we email ${session.user.email} a short note with a link back here.`
              : 'Off. Replies from the team wait here, under “Messages”, until you sign in.'}
          </p>
          <form action={setReplyEmailsAction} className="mt-5">
            <input type="hidden" name="on" value={replyEmails ? 'false' : 'true'} />
            <button type="submit" className="vix-btn vix-btn-quiet vix-btn-small">
              {replyEmails ? 'Turn these emails off' : 'Turn these emails on'}
            </button>
          </form>
        </section>
      )}

      {!first && (
        <p className="vix-quiet vix-rule mt-14 border-t pt-6">
          To close this account, or to give somebody else at{' '}
          {session.user.companyName} their own, ask us under “Messages”.
        </p>
      )}
    </>
  );
}

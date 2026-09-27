import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { Field, PageHeader } from '@/components/ui';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { PasswordForm } from '../PasswordForm';
import { ProfileForm } from './ProfileForm';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await auth();
  const user = session!.user;

  /*
   * Read from the database, not from the session.
   *
   * The token is minted at sign-in and carries the name as it was then. Editing
   * a profile against a twelve-hour-old copy of it would show somebody their old
   * name in the box they had just corrected.
   */
  const me = await withUser(async (tx, who) => {
    const found = await tx.execute<{
      full_name: string; bio: string | null;
      has_avatar: boolean; has_banner: boolean;
    }>(sql`
      SELECT full_name, bio, has_avatar, has_banner
        FROM app.team_directory WHERE id = ${who.id}
    `);
    return found.rows[0] ?? null;
  });

  return (
    <>
      <PageHeader eyebrow="VIXART OS" title="My account" />

      <div className="max-w-md">
        <Field label="Email" value={user.email} />
        <Field label="Job title" value={user.jobTitle} />
        <Field
          label="Access"
          value={
            user.role === 'admin'
              ? 'Management — everything'
              : user.role === 'moderator'
                ? 'Work moderator — everything'
                : 'Team — your own work'
          }
        />
        <p className="mt-2 text-[13.5px]" style={{ opacity: 0.55 }}>
          Your email, your job title and your access are set by management.
        </p>
      </div>

      <section className="mt-12 max-w-xl">
        <h2 className="label border-b border-void pb-2">My profile</h2>
        <p className="prose-vixart mt-4" style={{ opacity: 0.68 }}>
          What the team sees when they open you from{' '}
          <Link href="/team" className="underline underline-offset-2">Team</Link>.
        </p>
        <div className="mt-6">
          <ProfileForm
            personId={user.id}
            fullName={me?.full_name ?? user.name ?? ''}
            bio={me?.bio ?? null}
            hasAvatar={Boolean(me?.has_avatar)}
            hasBanner={Boolean(me?.has_banner)}
          />
        </div>
      </section>

      <section className="mt-12 max-w-xl">
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

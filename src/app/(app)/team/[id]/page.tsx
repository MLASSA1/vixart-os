import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { PageHeader } from '@/components/ui';
import { withUser } from '@/db/session';
import { Avatar } from '../../chat/ChatBits';

/**
 * One colleague.
 *
 * Asked for in these words: when a member clicks on another member they see
 * their information, their role in the company, and their description.
 *
 * WHAT IS NOT HERE. No email address and no telephone number, deliberately —
 * everybody on this team already has each other's, and a directory page that
 * republishes them is a page to think about the day somebody leaves. No task
 * list either: what a colleague is working on is a management view, and this is
 * a page every member can open.
 *
 * Readable by anybody signed in, including a member. It is the one page in the
 * team space whose whole purpose is to be looked at by colleagues.
 */
export const dynamic = 'force-dynamic';

const ACCESS: Record<string, string> = {
  admin: 'Management',
  moderator: 'Work moderator',
  member: 'Team',
};

interface Person {
  [k: string]: unknown;
  id: string;
  full_name: string;
  job_title: string | null;
  role: string;
  is_active: boolean;
  bio: string | null;
  has_avatar: boolean;
  has_banner: boolean;
}

export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Never let a non-uuid reach PostgreSQL's parser: it answers with a 500, which
  // says more about the stack than a 404 does.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const session = await auth();
  const me = session!.user;

  const person = await withUser(async (tx) => {
    const found = await tx.execute<Person>(sql`
      SELECT id::text, full_name, job_title, role, is_active, bio,
             has_avatar, has_banner
        FROM app.team_directory
       WHERE id = ${id} AND is_person
    `);
    return found.rows[0] ?? null;
  });

  if (!person) notFound();
  const mine = person.id === me.id;

  return (
    <>
      <PageHeader
        eyebrow="Team"
        title={person.full_name}
        actions={
          mine ? (
            <Link href="/account" className="btn btn-quiet">Edit my profile</Link>
          ) : (
            /*
             * The one action worth putting here. Every person is already a row
             * in the private list, so this is a shortcut rather than a new
             * doorway — and it goes through the route that opens the
             * conversation, so it works before one exists.
             */
            <Link href={`/chat/with/${person.id}`} className="btn btn-quiet">
              Send a message
            </Link>
          )
        }
      />

      {/* The banner, or the space where one would be. Not a placeholder image:
          an empty strip reads as "nothing here yet", a stock graphic reads as a
          mistake. */}
      <div className="max-w-3xl overflow-hidden rounded-[14px] bg-void/[0.05]">
        {person.has_banner ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={`/api/avatar/${person.id}?banner=1`}
            alt=""
            className="h-40 w-full object-cover sm:h-52"
          />
        ) : (
          <div className="h-20 sm:h-24" />
        )}
      </div>

      <div className="-mt-10 max-w-3xl px-5 sm:-mt-12 sm:px-7">
        <div className="inline-block rounded-[18px] bg-paper p-1.5">
          <Avatar name={person.full_name} id={person.id} size={80} />
        </div>
      </div>

      <div className="mt-5 max-w-3xl px-1">
        <h2 className="display text-[22px] font-bold">{person.full_name}</h2>
        <p className="mt-1 text-[15px]" style={{ opacity: 0.68 }}>
          {person.job_title ?? 'No job title set'}
          {' · '}
          {ACCESS[person.role] ?? person.role}
          {!person.is_active && ' · no longer active'}
        </p>

        {person.bio ? (
          <p className="prose-vixart mt-6 whitespace-pre-wrap" style={{ maxWidth: '62ch' }}>
            {person.bio}
          </p>
        ) : (
          <p className="mt-6 text-[15px]" style={{ opacity: 0.5 }}>
            {mine
              ? 'You have not written anything about yourself yet.'
              : `${person.full_name.split(' ')[0]} has not written anything here yet.`}
          </p>
        )}
      </div>
    </>
  );
}

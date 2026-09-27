import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { requireSession } from '@/auth';
import { withUser } from '@/db/session';

/**
 * The conversation with one person, whether or not it exists yet.
 *
 * Every colleague is now a row in the private list, including the ones you have
 * never written to — so a link has to work before there is a thread to link to.
 * This is that link: find the conversation, or open it, then go there.
 *
 * WHY A PAGE AND NOT A BUTTON.
 *
 * The alternative is a form per person in the sidebar, which is eight forms and
 * eight submit buttons dressed up as list rows, and a full round trip with no
 * navigation to show for it. A link is what a list row is.
 *
 * It does create a row on a GET, which is worth being deliberate about. It is
 * idempotent — a unique index keeps one conversation per pair whichever way
 * round it is opened — it requires a signed-in member of staff, and the thing it
 * creates is empty and private to the two people named. Nothing is disclosed and
 * nothing accumulates: clicking a name twice produces one thread.
 */
export const dynamic = 'force-dynamic';

export default async function ChatWithPerson({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // A person id that is not a uuid never reaches the database: PostgreSQL's
  // uuid parser would answer with a 500, which says more about the stack than
  // a 404 does.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const session = await requireSession();
  if (id === session.user.id) redirect('/chat');

  const threadId = await withUser(async (tx, user) => {
    /*
     * Who may be written to is asked of the directory, not assumed from the
     * url. A service account has no inbox — a trigger refuses the thread — and
     * somebody deactivated should not be reachable at all.
     */
    const person = await tx.execute<{ id: string }>(sql`
      SELECT u.id FROM app.team_directory u
       WHERE u.id = ${id} AND u.is_active AND u.is_person
    `);
    if (!person.rows[0]) return null;

    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM thread
       WHERE kind = 'dm'
         -- The same expression as thread_one_dm_per_pair, so this reads the
         -- unique index rather than scanning: a pair is identified by its two
         -- ids sorted, whichever way round the conversation was opened.
         AND least(participant_a, participant_b) = least(${user.id}::uuid, ${id}::uuid)
         AND greatest(participant_a, participant_b) = greatest(${user.id}::uuid, ${id}::uuid)
    `);
    const found = existing.rows[0];
    if (found) return found.id;

    const made = await tx.execute<{ id: string }>(sql`
      INSERT INTO thread (kind, title, participant_a, participant_b, created_by_id)
      VALUES ('dm', 'Direct message', ${user.id}, ${id}, ${user.id})
      -- One conversation per pair, whichever way round it was opened. Two people
      -- clicking each other's name at the same moment must not end up with two
      -- threads, each holding half of what was said.
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    if (made.rows[0]) return made.rows[0].id;

    // Lost the race. The other insert won, so read it back.
    const after = await tx.execute<{ id: string }>(sql`
      SELECT id FROM thread
       WHERE kind = 'dm'
         -- The same expression as thread_one_dm_per_pair, so this reads the
         -- unique index rather than scanning: a pair is identified by its two
         -- ids sorted, whichever way round the conversation was opened.
         AND least(participant_a, participant_b) = least(${user.id}::uuid, ${id}::uuid)
         AND greatest(participant_a, participant_b) = greatest(${user.id}::uuid, ${id}::uuid)
    `);
    return after.rows[0]?.id ?? null;
  });

  if (!threadId) notFound();
  redirect(`/chat/${threadId}`);
}

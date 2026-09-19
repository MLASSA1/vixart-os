import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { markThreadRead } from '@/lib/chat-read';
import { listMessages } from '@/lib/chat-queries';
import {
  editMessageAction,
  postMessageAction,
  withdrawMessageAction,
} from '../actions';
import { MessagePane } from '../MessagePane';

/**
 * One channel.
 *
 * A channel you cannot see 404s exactly as one that does not exist would.
 * There is no "you do not have access" screen, because that sentence confirms
 * the conversation is there.
 */
export const dynamic = 'force-dynamic';

interface ChannelRow {
  [k: string]: unknown;
  id: string;
  kind: string;
  title: string;
  is_default: boolean;
  company_id: string | null;
  company_name: string | null;
  participant_a: string | null;
  participant_b: string | null;
  other_name: string | null;
  project_id: string | null;
  project_name: string | null;
}

export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A channel id that is not a uuid never reaches the database. Passing it
  // through produced a 500 from PostgreSQL's uuid parser — a crash on a URL
  // anybody can type, and one that says more about the stack than a 404 does.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const session = await auth();
  const me = session!.user;

  const data = await withUser(async (tx, user) => {
    const found = await tx.execute<ChannelRow>(sql`
      SELECT t.id, t.kind, t.title, t.is_default,
             t.company_id, c.name AS company_name,
             t.project_id, p.name AS project_name,
             t.participant_a, t.participant_b,
             CASE WHEN t.kind = 'dm' THEN
               (SELECT full_name FROM app_user u
                 WHERE u.id = CASE WHEN t.participant_a = ${user.id}
                                   THEN t.participant_b ELSE t.participant_a END)
             END AS other_name
        FROM thread t
        LEFT JOIN company c ON c.id = t.company_id
        LEFT JOIN project p ON p.id = t.project_id
       WHERE t.id = ${id}
    `);
    const record = found.rows[0];
    if (!record) return null;

    const messages = await listMessages(tx, id, user.id);

    // Who may be named here: a real person who can open this channel. Asked of
    // the thread table, so the answer comes from its policy and not a copy.
    const people = await tx.execute<{ id: string; full_name: string }>(sql`
      SELECT u.id, u.full_name
        FROM app.team_directory u
       WHERE u.is_active
         AND u.is_person
         AND EXISTS (SELECT 1 FROM thread t WHERE t.id = ${id})
       ORDER BY u.full_name
    `);

    // Opening a channel is reading it. Inside the transaction that has just
    // proved it is visible, and NOT in an action — an action revalidates, and
    // a revalidate during a render is what returned 500 on every channel.
    await markThreadRead(tx, user.id, id);

    return { record, messages, people: people.rows };
  });

  if (!data) notFound();
  const { record, messages, people } = data;

  const isDm = record.kind === 'dm';

  const about =
    record.kind === 'company'
      ? { href: `/companies/${record.company_id}`, name: record.company_name }
      : record.kind === 'project'
        ? { href: `/projects/${record.project_id}`, name: record.project_name }
        : null;

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-void/10 bg-surface px-4 py-2.5 sm:px-5">
        <span aria-hidden="true" className="text-[19px] leading-none text-void/25">
          {isDm ? '@' : '#'}
        </span>
        <div className="min-w-0">
          <h1 className="display truncate text-[16px] font-bold leading-tight">
          {isDm ? (record.other_name ?? 'Conversation') : record.title}
        </h1>
          <p className="hint truncate text-[12.5px] leading-tight">
            {isDm ? (
              'Private — only the two of you can read this.'
            ) : about ? (
              <>
                <Link href={about.href} className="underline underline-offset-2">
                  {about.name}
                </Link>
                {' — whoever can see that record can read this.'}
              </>
            ) : (
              'Everyone on the team.'
            )}
          </p>
        </div>
      </header>

      <MessagePane
        threadId={id}
        initial={messages}
        meId={me.id}
        mentionable={people.map((p) => ({ id: String(p.id), fullName: String(p.full_name) }))}
        dmWith={isDm ? (record.other_name ?? null) : null}
        postAction={postMessageAction.bind(null, id)}
        editAction={editMessageAction.bind(null, id)}
        withdrawAction={withdrawMessageAction.bind(null, id)}
      />
    </>
  );
}

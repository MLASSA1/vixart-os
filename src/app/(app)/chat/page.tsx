import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { since } from '@/lib/format';
import { createThreadAction } from './actions';
import { NewThreadForm } from './ChatForms';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string; kind: string; title: string;
  company_name: string | null; project_name: string | null;
  updated_at: string; message_count: string; unread: string;
  last_author: string | null;
}

/**
 * Every thread this person can see.
 *
 * "Can see" is the database's answer, not this page's: a thread about a client
 * is returned only if the client is, so the list cannot leak the existence of a
 * conversation about something you are not allowed to know about.
 */
export default async function ChatPage() {
  const session = await auth();
  const me = session!.user;

  const { rows, companies, projects } = await withUser(async (tx) => {
    const list = await tx.execute<Row>(sql`
      SELECT t.id, t.kind, t.title,
             c.name AS company_name,
             p.name AS project_name,
             t.updated_at::text,
             (SELECT count(*)::text FROM message m WHERE m.thread_id = t.id) AS message_count,
             -- Unread = posted since I last opened it, and never my own.
             (SELECT count(*)::text FROM message m
               WHERE m.thread_id = t.id
                 AND m.author_id <> ${me.id}
                 AND m.created_at > coalesce(
                   (SELECT r.last_read_at FROM thread_read r
                     WHERE r.thread_id = t.id AND r.user_id = ${me.id}),
                   'epoch'::timestamptz)) AS unread,
             (SELECT m.author_name FROM message m
               WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_author
        FROM thread t
        LEFT JOIN company c ON c.id = t.company_id
        LEFT JOIN project p ON p.id = t.project_id
       ORDER BY t.updated_at DESC
    `);

    const comps = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM company ORDER BY lower(name)
    `);
    const projs = await tx.execute<{ id: string; label: string }>(sql`
      SELECT p.id, p.name || ' — ' || c.name AS label
        FROM project p JOIN company c ON c.id = p.company_id
       WHERE p.status <> 'delivered' ORDER BY lower(p.name)
    `);

    return { rows: list.rows, companies: comps.rows, projects: projs.rows };
  });

  const totalUnread = rows.reduce((a, r) => a + Number(r.unread), 0);

  return (
    <>
      <PageHeader
        eyebrow={totalUnread > 0 ? `${totalUnread} unread` : 'Team'}
        title="Chat"
      />

      <p className="prose-vixart" style={{ opacity: 0.7 }}>
        Threads, not one room. A message can be corrected for fifteen minutes and
        then it stands — nothing here is ever deleted.
      </p>

      <Section title={`Threads — ${rows.length}`}>
        {rows.length === 0 ? (
          <Empty message="No threads yet — start one below" />
        ) : (
          <ul className="grid gap-3">
            {rows.map((r) => {
              const unread = Number(r.unread);
              return (
                <li key={r.id}>
                  <Link
                    href={`/chat/${r.id}`}
                    className="card block px-5 py-4 transition-shadow hover:shadow-md"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <p className={unread > 0 ? 'font-bold' : 'font-semibold'}>
                        {r.title}
                      </p>
                      {unread > 0 && (
                        <span className="chip tone-accent">{unread} new</span>
                      )}
                    </div>
                    <p className="hint mt-1">
                      {r.kind === 'general'
                        ? 'The agency'
                        : r.kind === 'company'
                          ? r.company_name
                          : r.project_name}
                      {' · '}
                      {r.message_count} message{Number(r.message_count) === 1 ? '' : 's'}
                      {r.last_author ? ` · last from ${r.last_author}` : ''}
                      {' · '}
                      {since(r.updated_at)}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Start a thread">
        <NewThreadForm action={createThreadAction} companies={companies} projects={projects} />
      </Section>
    </>
  );
}

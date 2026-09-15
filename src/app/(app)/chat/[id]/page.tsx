import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { ButtonLink, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { formatBytes } from '@/lib/upload-types';
import { since } from '@/lib/format';
import { editMessageAction, markThreadReadAction, postMessageAction } from '../actions';
import { EditMessageForm, PostMessageForm } from '../ChatForms';

export const dynamic = 'force-dynamic';

interface ThreadRow {
  [k: string]: unknown;
  id: string; kind: string; title: string;
  company_id: string | null; company_name: string | null;
  project_id: string | null; project_name: string | null;
}

interface MsgRow {
  [k: string]: unknown;
  id: string; author_id: string; author_name: string; body: string;
  created_at: string; edited_at: string | null; editable: boolean;
  file_id: string | null; file_name: string | null;
  file_size: string | null; file_mime: string | null;
}

/**
 * One thread.
 *
 * A thread you cannot see 404s exactly as one that does not exist would. There
 * is no "you do not have access" screen, because that sentence confirms the
 * conversation is there.
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const me = session!.user;

  const data = await withUser(async (tx) => {
    const t = await tx.execute<ThreadRow>(sql`
      SELECT t.id, t.kind, t.title,
             t.company_id, c.name AS company_name,
             t.project_id, p.name AS project_name
        FROM thread t
        LEFT JOIN company c ON c.id = t.company_id
        LEFT JOIN project p ON p.id = t.project_id
       WHERE t.id = ${id}
    `);
    const record = t.rows[0];
    if (!record) return null;

    const msgs = await tx.execute<MsgRow>(sql`
      SELECT m.id, m.author_id, m.author_name, m.body,
             m.created_at::text, m.edited_at::text,
             -- The window, computed by the database so the button and the
             -- trigger cannot disagree about whether it is still open.
             (m.author_id = ${me.id} AND m.created_at > now() - interval '15 minutes') AS editable,
             a.id::text          AS file_id,
             a.original_name     AS file_name,
             a.size_bytes::text  AS file_size,
             a.mime_type         AS file_mime
        FROM message m
        LEFT JOIN attachment a
          ON a.entity_type = 'message' AND a.entity_id = m.id
       WHERE m.thread_id = ${id}
       ORDER BY m.created_at
    `);

    return { record, messages: msgs.rows };
  });

  if (!data) notFound();
  const { record, messages } = data;

  // Opening the thread is reading it. One timestamp, not a receipt per message.
  await markThreadReadAction(id);

  const about =
    record.kind === 'general'
      ? null
      : record.kind === 'company'
        ? { href: `/companies/${record.company_id}`, name: record.company_name }
        : { href: `/projects/${record.project_id}`, name: record.project_name };

  return (
    <>
      <PageHeader
        eyebrow={
          record.kind === 'general'
            ? 'The agency'
            : record.kind === 'company'
              ? 'Client thread'
              : 'Project thread'
        }
        title={record.title}
        actions={<ButtonLink href="/chat" inverse>All threads</ButtonLink>}
      />

      {about && (
        <p className="hint">
          About{' '}
          <Link href={about.href} className="underline underline-offset-4">
            {about.name}
          </Link>
          {' — whoever can see that record can read this.'}
        </p>
      )}

      <Section title={`Messages — ${messages.length}`}>
        {messages.length === 0 ? (
          <p className="hint">Nothing yet. The first message is below.</p>
        ) : (
          <ul className="space-y-4">
            {messages.map((m) => {
              const mine = m.author_id === me.id;
              return (
                <li key={m.id} className={mine ? 'border-l-2 border-accent pl-4' : 'pl-4'}>
                  <p className="label">
                    {m.author_name}
                    <span className="hint"> · {since(m.created_at)}</span>
                    {m.edited_at && <span className="hint"> · corrected</span>}
                  </p>

                  <p className="prose-vixart mt-1 whitespace-pre-wrap">{m.body}</p>

                  {m.file_id && (
                    <p className="mt-2">
                      {/* Never a static path. The only way to the bytes is the
                          authenticated route, which re-checks who is asking. */}
                      <a
                        href={`/api/files/${m.file_id}`}
                        className="chip tone-quiet underline underline-offset-4"
                      >
                        {m.file_name}
                        {m.file_size ? ` · ${formatBytes(Number(m.file_size))}` : ''}
                      </a>
                    </p>
                  )}

                  {m.editable && (
                    <div className="mt-1">
                      <EditMessageForm
                        action={editMessageAction.bind(null, id)}
                        messageId={m.id}
                        body={m.body}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Say something">
        <PostMessageForm action={postMessageAction.bind(null, id)} />
        <p className="hint mt-3">
          Fifteen minutes to correct a typo. After that it stands, and nothing here
          is ever deleted — it is a record, like the activity log.
        </p>
      </Section>
    </>
  );
}

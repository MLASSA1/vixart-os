import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { capped } from '@/lib/list-caps';
import { since } from '@/lib/format';
import { markAllReadAction, markNotificationReadAction } from './actions';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  task_assigned: 'Assigned to you',
  mentioned: 'Mentioned',
  task_overdue: 'Overdue',
  task_awaiting_signoff: 'Waiting on your sign-off',
};

const KIND_TONE: Record<string, string> = {
  task_assigned: 'tone-accent',
  mentioned: 'tone-accent',
  task_overdue: 'tone-danger',
  task_awaiting_signoff: 'tone-warn',
};

interface Row {
  [k: string]: unknown;
  id: string; kind: string; title: string; body: string | null; link: string;
  actor_name: string | null; read_at: string | null; created_at: string;
}

/**
 * Everything waiting for this person.
 *
 * No filtering here and no joins: `notification_own` is
 * `recipient_id = app.current_user_id()`, so the query can only return rows
 * addressed to whoever is asking.
 */
export default async function InboxPage() {
  const session = await auth();
  const me = session!.user;

  const rows = await withUser(async (tx) => {
    const r = await tx.execute<Row>(sql`
      SELECT id, kind, title, body, link, actor_name,
             read_at::text, created_at::text
        FROM notification
       ORDER BY read_at IS NOT NULL, created_at DESC
       LIMIT 200
    `);
    return r.rows;
  });

  const unread = rows.filter((r) => !r.read_at);

  return (
    <>
      <PageHeader
        eyebrow={me.name ?? 'You'}
        title="Inbox"
        actions={
          unread.length > 0 ? (
            <form action={markAllReadAction}>
              <button type="submit" className="btn btn-inverse btn-small">
                Mark all read
              </button>
            </form>
          ) : undefined
        }
      />

      <p className="prose-vixart" style={{ opacity: 0.7 }}>
        Work handed to you, your name in a conversation, your own work past its
        date, and anything waiting on your sign-off. Nothing here is sent
        anywhere — no email, no message, no notification off this machine.
      </p>

      <Section title={unread.length > 0 ? `Unread — ${unread.length}` : 'Nothing unread'}>
        {unread.length === 0 ? (
          <Empty message="You are up to date" />
        ) : (
          <ul className="grid gap-3">
            {capped(unread).shown.map((n) => (
              <li key={n.id} className="card px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <span className={`chip ${KIND_TONE[n.kind] ?? 'tone-quiet'}`}>
                      {KIND_LABEL[n.kind] ?? n.kind}
                    </span>
                    <p className="mt-2 font-semibold">
                      <Link href={n.link} className="underline-offset-4 hover:underline">
                        {n.title}
                      </Link>
                    </p>
                    {n.body && <p className="hint mt-0.5">{n.body}</p>}
                    <p className="hint mt-0.5">
                      {n.actor_name ? `${n.actor_name} · ` : ''}
                      {since(n.created_at)}
                    </p>
                  </div>
                  <form action={markNotificationReadAction}>
                    <input type="hidden" name="notificationId" value={n.id} />
                    <button
                      type="submit"
                      className="hint cursor-pointer underline underline-offset-4"
                    >
                      Mark read
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        {capped(unread).hidden > 0 && (
          <p className="hint mt-3">{capped(unread).hidden} more unread not shown.</p>
        )}
      </Section>

      {rows.length > unread.length && (
        <Section title="Earlier">
          <ul className="divide-y divide-void/10">
            {capped(rows.filter((r) => r.read_at)).shown.map((n) => (
              <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5">
                <span className="min-w-0">
                  <span className="hint">{KIND_LABEL[n.kind] ?? n.kind} · </span>
                  <Link href={n.link} className="underline-offset-4 hover:underline">
                    {n.title}
                  </Link>
                </span>
                <span className="hint">{since(n.created_at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

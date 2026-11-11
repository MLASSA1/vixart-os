import { Fragment } from 'react';
import { redirect } from 'next/navigation';
import { requireClientPage } from '../session';
import { withClient } from '@/db/session';
import { findSupportThread, listPortalMessages, markSupportRead, readPortalInbox } from '@/lib/client-portal-queries';
import { PortalTitle } from '../PortalTitle';
import { SupportComposer } from './Composer';
import { PortalAttachment } from './PortalAttachment';
import { formatDayMonthClock } from '@/lib/format';

export const dynamic = 'force-dynamic';

// Rendered on the server, in a stated zone rather than whatever TZ the
// process happens to have: see src/lib/format.ts.
const when = formatDayMonthClock;

export default async function SupportPage() {
  const session = await requireClientPage();
  if (session.user.mustChangePassword) redirect('/portal/account');

  /*
   * Read what was new BEFORE marking it read, so the divider below can still
   * say where "new" starts on this visit; then mark it, so the count in the
   * navigation clears on the next page.
   */
  const { messages, inbox } = await withClient(session.user.id, async (tx) => {
    const inbox = await readPortalInbox(tx);
    const messages = await listPortalMessages(tx);
    const thread = await findSupportThread(tx);
    if (thread) await markSupportRead(tx, thread);
    return { messages, inbox };
  });

  // The first reply from us that this visit is the first to show.
  const firstNew = inbox.unread > 0
    ? messages.find((m) => !m.mine && (inbox.last_read_at === null || m.created_at > inbox.last_read_at))?.id
    : undefined;
  // Their latest message, and whether anyone on the team has opened the
  // conversation since it was sent.
  const lastMine = [...messages].reverse().find((m) => m.mine && !m.withdrawn_at);
  const seen = Boolean(lastMine && inbox.seen_by_team_at && inbox.seen_by_team_at >= lastMine.created_at);

  return (
    <>
      <PortalTitle
        eyebrow={session.user.companyName ?? ''}
        title="Messages"
        lead="Straight to the team, and private between you and VIXART. Write, or attach a photo, a video or a document."
      />

      {messages.length === 0 ? (
        <div className="vix-card mt-10 px-7 py-8">
          <p className="font-semibold">Nothing said yet.</p>
          <p className="vix-body mt-2">Write the first thing below.</p>
        </div>
      ) : (
        <ul className="mt-10 space-y-3">
          {messages.map((m) => (
            <Fragment key={m.id}>
            {m.id === firstNew && (
              <li className="vix-new" aria-label="New messages start here">
                <span className="vix-meta">New</span>
              </li>
            )}
            <li
              className={`max-w-[85%] px-5 py-4 ${
                m.mine ? 'vix-said-them ml-auto' : 'vix-said-us'
              }`}
            >
              <p className="vix-meta">{m.mine ? 'You' : m.author_name}</p>
              {m.withdrawn_at ? (
                <p className="vix-quiet mt-2 italic">This message was withdrawn.</p>
              ) : (
                <>
                  {/* "(file)" is the placeholder written when something is sent
                      with no words beside it. Showing it would be showing the
                      database's private business to the reader. */}
                  {!(m.file_id && m.body === '(file)') && (
                    <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap">
                      {m.body}
                    </p>
                  )}
                  {m.file_id && (
                    <PortalAttachment
                      fileId={m.file_id}
                      name={m.file_name}
                      mime={m.file_mime}
                      sizeBytes={m.file_size === null ? null : Number(m.file_size)}
                      durationMs={
                        m.file_duration_ms === null ? null : Number(m.file_duration_ms)
                      }
                    />
                  )}
                </>
              )}
              <p className="vix-quiet mt-2 text-[11.5px]">
                {when(m.created_at)}
                {m.id === lastMine?.id && (seen ? ' · Seen by the team' : ' · Sent')}
              </p>
            </li>
            </Fragment>
          ))}
        </ul>
      )}

      <SupportComposer />
    </>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MESSAGE_PAGE, type MessageRow } from '@/lib/chat-queries';
import { subscribeToChat } from '@/lib/chat-stream-client';
import type { FormState } from '@/lib/form-state';
import { Attachment } from './Attachment';
import { Avatar, clockTime, dayLabel, hueFor, MentionText } from './ChatBits';
import { Composer, EditMessageForm } from './ChatForms';

/**
 * One channel: oldest at the top, newest at the bottom, composer pinned below.
 *
 * Consecutive messages from the same person inside five minutes share a header,
 * because a name and a face repeated six times is six times less readable. A
 * divider marks each new day.
 */

/** Long enough that a burst reads as one thought, short enough to stay honest. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Where your own messages sit.
 *
 * `false` is Discord: one column, every message the same shape, who is
 * speaking carried by the avatar and the coloured name. `true` is WhatsApp:
 * your own swing to the right and drop their name, because with two people
 * the side IS the name.
 *
 * One column wins here. A channel with four people in it gives the right-hand
 * side no meaning — it says "me" and nothing about the other three — while
 * costing every one of their messages a ragged edge to read down. Your own
 * messages keep the violet tint either way, so you can still find yourself.
 */
const OWN_ON_RIGHT = false;

/**
 * Who wrote it, as one value — whether that is a colleague or a client.
 *
 * A message carries EITHER `author_id` (staff) or `author_contact_id` (a
 * client writing from the portal); 0064 made them exclusive and made the first
 * one nullable. Every place that wants "which person is this" wanted both
 * columns and was written before the second existed, so each one quietly meant
 * "staff only": the colour reached for `author_id` and threw on null, and the
 * grouping compared `null !== null`, which is false — so two different
 * contacts writing in a row were folded into one run under the first one's
 * name. A message attributed to the wrong person is worse than an ugly one.
 *
 * The name is the last resort and never NULL, so this always returns a string.
 */
function authorKey(m: MessageRow): string {
  return m.author_id ?? m.author_contact_id ?? m.author_name;
}

function sameGroup(a: MessageRow | undefined, b: MessageRow): boolean {
  if (!a || authorKey(a) !== authorKey(b)) return false;
  if (new Date(a.created_at).toDateString() !== new Date(b.created_at).toDateString()) return false;
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime() < GROUP_WINDOW_MS;
}

export function MessagePane({
  threadId,
  initial,
  meId,
  mentionable,
  dmWith,
  hasEarlier,
  postAction,
  editAction,
  withdrawAction,
}: {
  threadId: string;
  initial: MessageRow[];
  meId: string;
  mentionable: ReadonlyArray<{ id: string; fullName: string }>;
  /** The other person, when this is a conversation rather than a channel. */
  dmWith: string | null;
  /** Whether the channel goes further up than the page we were given. */
  hasEarlier: boolean;
  postAction: (state: FormState, formData: FormData) => Promise<FormState>;
  editAction: (state: FormState, formData: FormData) => Promise<FormState>;
  withdrawAction: (formData: FormData) => Promise<void>;
}) {
  const [messages, setMessages] = useState(initial);
  /** Whether announcements are arriving. Decides the fallback interval only. */
  const [streaming, setStreaming] = useState(false);
  /** More above what is on screen, and whether we are fetching it. */
  const [earlier, setEarlier] = useState(hasEarlier);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [dropped, setDropped] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const names = mentionable.map((p) => p.fullName);

  // A channel switch remounts nothing — the layout persists — so the incoming
  // server data replaces what is on screen.
  useEffect(() => {
    setMessages(initial);
    setEarlier(hasEarlier);
  }, [initial, hasEarlier]);

  /**
   * The page above the one on screen.
   *
   * Prepending moves everything down, so the reader would be looking at a
   * different message than the one they were reading a moment ago. The scroll
   * position is therefore restored by height difference: whatever they were
   * reading stays under their eyes, and the new page appears above it — which
   * is what going back up a conversation is supposed to feel like.
   */
  const loadEarlier = useCallback(async () => {
    const el = scrollRef.current;
    const oldest = messages[0]?.created_at;
    if (!oldest || loadingEarlier) return;

    setLoadingEarlier(true);
    const before = el?.scrollHeight ?? 0;
    try {
      const response = await fetch(
        `/api/chat/threads/${threadId}/messages?before=${encodeURIComponent(oldest)}`,
        { cache: 'no-store' },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { messages: MessageRow[] };
      if (data.messages.length === 0) {
        setEarlier(false);
        return;
      }

      setMessages((current) => {
        const byId = new Map(data.messages.map((m) => [m.id, m]));
        for (const m of current) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
      // A short page means we have reached the top of the channel.
      setEarlier(data.messages.length >= MESSAGE_PAGE);

      requestAnimationFrame(() => {
        const after = el?.scrollHeight ?? 0;
        if (el) el.scrollTop += after - before;
      });
    } catch {
      // Nothing changes. The button is still there to try again.
    } finally {
      setLoadingEarlier(false);
    }
  }, [messages, threadId, loadingEarlier]);

  const poll = useCallback(async () => {
    if (document.hidden) return;
    // The high-water mark, edits included: a correction moves `edited_at`
    // without moving `created_at`, and it should still arrive.
    let after: string | null = null;
    for (const m of messages) {
      for (const stamp of [m.created_at, m.edited_at]) {
        if (stamp && (after === null || stamp > after)) after = stamp;
      }
    }

    try {
      const url = `/api/chat/threads/${threadId}/messages${
        after ? `?after=${encodeURIComponent(after)}` : ''
      }`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return;
      const data = (await response.json()) as { messages: MessageRow[] };
      if (data.messages.length === 0) return;

      setMessages((current) => {
        // Merged by id, so a correction replaces rather than duplicates.
        const byId = new Map(current.map((m) => [m.id, m]));
        for (const m of data.messages) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
    } catch {
      // A poll that fails is a poll. What is on screen stays.
    }
  }, [messages, threadId]);

  // The stream is what makes a message arrive at once; the poll is what makes
  // it arrive at all. Both are kept, and the poll simply slows down while the
  // stream is carrying — because the moment the only delivery is a stream, a
  // stream that quietly stops delivering is a chat application that has
  // stopped working and says nothing about it.
  useEffect(() => {
    const unsubscribe = subscribeToChat({
      onChange: (changed) => {
        if (changed === threadId) void poll();
      },
      onReady: (mode) => {
        // A connect is also a gap: read what was missed, then settle.
        void poll();
        setStreaming(mode === 'live');
      },
      onDrop: () => setStreaming(false),
    });
    return unsubscribe;
  }, [poll, threadId]);

  // Five seconds without a stream, a minute with one, and nothing at all while
  // the tab is hidden — one core, eight sites. Coming back to the tab checks
  // immediately rather than waiting out the tick.
  useEffect(() => {
    const timer = setInterval(poll, streaming ? 60_000 : 5_000);
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll, streaming]);

  // Follow the bottom, unless the reader has scrolled up to look at something.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  let lastDay = '';

  return (
    <div
      className="chat-ground relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        const file = e.dataTransfer.files?.[0];
        if (!file) return;
        e.preventDefault();
        setDragging(false);
        // Attached, not sent: dropping a file should not post before the
        // sender has had the chance to say what it is.
        setDropped(file);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/[0.07]">
          <p className="text-accent-deep font-semibold">Drop to attach</p>
        </div>
      )}

      <div ref={scrollRef} className="chat-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
        {earlier && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={() => void loadEarlier()}
              disabled={loadingEarlier}
              className="rounded-full border border-void/15 bg-surface px-4 py-1.5 text-[13px] font-medium hover:border-void/30 disabled:opacity-50"
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}

        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-[15px] font-semibold">No messages yet</p>
            <p className="hint max-w-xs">
              {dmWith
                ? `Say the first thing. Only ${dmWith} will read it.`
                : 'Say the first thing. Everyone who can see this channel will read it.'}
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          const day = dayLabel(m.created_at);
          const newDay = day !== lastDay;
          lastDay = day;
          const mine = m.author_id === meId;
          // Whose it is, versus where it goes. In one column they part company.
          const sided = OWN_ON_RIGHT && mine;
          // A new day always starts a fresh run, so the name comes back.
          const grouped = !newDay && sameGroup(messages[i - 1], m);

          return (
            <div key={m.id}>
              {newDay && (
                <div className="my-3 flex justify-center">
                  <span className="daypill">{day}</span>
                </div>
              )}

              <div
                className={`msg-row flex items-start gap-2 ${grouped ? 'mt-0.5' : 'mt-2.5'} ${
                  sided ? 'flex-row-reverse' : ''
                }`}
              >
                {/* Held open even when empty, so a run of messages stays in
                    one column instead of stepping left under the avatar. */}
                <div className="w-8 shrink-0">
                  {!grouped && !sided && (
                    <Avatar name={m.author_name} id={authorKey(m)} size={32} />
                  )}
                </div>

                <div className={`flex min-w-0 flex-col ${sided ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`bubble ${mine ? 'bubble-out' : 'bubble-in'} ${
                      !grouped ? (sided ? 'bubble-out-first' : 'bubble-in-first') : ''
                    }`}
                  >
                    {/* The coloured name, on the first of a run. Dropped only
                        when the message has swung to the right, where the side
                        already says whose it is. */}
                    {!grouped && !sided && (
                      <p
                        className="mb-0.5 text-[13px] font-bold"
                        style={{ color: `hsl(${hueFor(authorKey(m))} 46% 38%)` }}
                      >
                        {m.author_name}
                      </p>
                    )}

                    {m.file_id && !m.withdrawn_at && (
                      <div className={m.body === '(file)' ? 'mb-0.5' : 'mb-1.5'}>
                        <Attachment
                          fileId={m.file_id}
                          name={m.file_name}
                          mime={m.file_mime}
                          sizeBytes={m.file_size === null ? null : Number(m.file_size)}
                          durationMs={
                            m.file_duration_ms === null ? null : Number(m.file_duration_ms)
                          }
                          mine={mine}
                        />
                      </div>
                    )}

                    {/*
                      A withdrawn message keeps its place and says who took it
                      back and when. It is not removed: a conversation that
                      silently rearranges itself afterwards is not a record.
                    */}
                    {m.withdrawn_at ? (
                      <span className="text-[13.5px] italic opacity-55">
                        Message withdrawn by {m.withdrawn_by ?? 'someone'}
                      </span>
                    ) : (
                      /* "(file)" is the placeholder the action writes when a
                         file travels alone. Showing it would be showing the
                         database's private business to the reader. */
                      !(m.file_id && m.body === '(file)') && (
                        <span className="whitespace-pre-wrap">
                          <MentionText body={m.body} names={names} />
                        </span>
                      )
                    )}

                    <span className="bubble-time">
                      {m.edited_at && !m.withdrawn_at && (
                        <span className="mr-1 italic">edited</span>
                      )}
                      {clockTime(m.created_at)}
                    </span>
                  </div>

                  {mine && !m.withdrawn_at && (
                    <div className="msg-actions mt-0.5 flex items-center gap-3 pl-1">
                      {m.editable && (
                        <EditMessageForm action={editAction} messageId={m.id} body={m.body} />
                      )}
                      {/* No time limit. The edit window exists so a correction
                          cannot quietly rewrite what was said an hour ago;
                          taking a message back leaves a mark, so it does not
                          need the same guard. */}
                      <form action={withdrawAction}>
                        <input type="hidden" name="messageId" value={m.id} />
                        <button
                          type="submit"
                          className="cursor-pointer text-[11.5px] font-medium text-void/45 hover:text-void hover:underline"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-3 pb-3 sm:px-5">
        <Composer
          action={postAction}
          mentionable={mentionable}
          dmWith={dmWith}
          dropped={dropped}
          onDropConsumed={() => setDropped(null)}
          onSent={poll}
        />
      </div>
    </div>
  );
}

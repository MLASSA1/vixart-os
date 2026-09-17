'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageRow } from '@/lib/chat-queries';
import type { FormState } from '@/lib/form-state';
import { formatBytes } from '@/lib/upload-types';
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

function sameGroup(a: MessageRow | undefined, b: MessageRow): boolean {
  if (!a || a.author_id !== b.author_id) return false;
  if (new Date(a.created_at).toDateString() !== new Date(b.created_at).toDateString()) return false;
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime() < GROUP_WINDOW_MS;
}

export function MessagePane({
  threadId,
  initial,
  meId,
  mentionable,
  postAction,
  editAction,
}: {
  threadId: string;
  initial: MessageRow[];
  meId: string;
  mentionable: ReadonlyArray<{ id: string; fullName: string }>;
  postAction: (state: FormState, formData: FormData) => Promise<FormState>;
  editAction: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [messages, setMessages] = useState(initial);
  const [dropped, setDropped] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const names = mentionable.map((p) => p.fullName);

  // A channel switch remounts nothing — the layout persists — so the incoming
  // server data replaces what is on screen.
  useEffect(() => {
    setMessages(initial);
  }, [initial]);

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

  // Five seconds, and nothing while the tab is hidden — one core, eight sites.
  // Coming back to the tab checks immediately rather than waiting out the tick.
  useEffect(() => {
    const timer = setInterval(poll, 5_000);
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

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
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-[15px] font-semibold">No messages yet</p>
            <p className="hint max-w-xs">Say the first thing. Everyone who can see this channel will read it.</p>
          </div>
        )}

        {messages.map((m, i) => {
          const day = dayLabel(m.created_at);
          const newDay = day !== lastDay;
          lastDay = day;
          const mine = m.author_id === meId;
          // A new day always starts a fresh run, so the name comes back.
          const grouped = !newDay && sameGroup(messages[i - 1], m);
          const image = (m.file_mime ?? '').startsWith('image/');

          return (
            <div key={m.id}>
              {newDay && (
                <div className="my-3 flex justify-center">
                  <span className="daypill">{day}</span>
                </div>
              )}

              <div
                className={`msg-row flex items-start gap-2 ${grouped ? 'mt-0.5' : 'mt-2.5'} ${
                  mine ? 'flex-row-reverse' : ''
                }`}
              >
                {/* Held open even when empty, so a run of messages stays in
                    one column instead of stepping left under the avatar. */}
                <div className="w-8 shrink-0">
                  {!grouped && !mine && <Avatar name={m.author_name} size={32} />}
                </div>

                <div className={`flex min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`bubble ${mine ? 'bubble-out' : 'bubble-in'} ${
                      !grouped ? (mine ? 'bubble-out-first' : 'bubble-in-first') : ''
                    }`}
                  >
                    {/* The coloured name, as a group chat does it — only on the
                        first of a run, and never on your own. */}
                    {!grouped && !mine && (
                      <p
                        className="mb-0.5 text-[13px] font-bold"
                        style={{ color: `hsl(${hueFor(m.author_name)} 46% 38%)` }}
                      >
                        {m.author_name}
                      </p>
                    )}

                    {m.file_id && (
                      <div className={m.body === '(file)' ? 'mb-0.5' : 'mb-1.5'}>
                        {/* Never a static path: the only way to the bytes is
                            the authenticated route, which re-checks who asks. */}
                        {image ? (
                          <a href={`/api/files/${m.file_id}`} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/files/${m.file_id}`}
                              alt={m.file_name ?? 'Attachment'}
                              className="max-h-80 w-full rounded-[11px] object-cover"
                            />
                          </a>
                        ) : (
                          <a
                            href={`/api/files/${m.file_id}`}
                            className={`flex items-center gap-2.5 rounded-[11px] px-2.5 py-2 ${
                              mine ? 'bg-void/[0.06] hover:bg-void/[0.1]' : 'bg-void/[0.045] hover:bg-void/[0.08]'
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-void/10 text-[15px]"
                            >
                              ▤
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[13.5px] font-semibold">
                                {m.file_name}
                              </span>
                              <span className="block text-[11.5px] text-void/50">
                                {m.file_size ? formatBytes(Number(m.file_size)) : ''}
                              </span>
                            </span>
                          </a>
                        )}
                      </div>
                    )}

                    {/* "(file)" is the placeholder the action writes when a
                        file travels alone. Showing it would be showing the
                        database's private business to the reader. */}
                    {!(m.file_id && m.body === '(file)') && (
                      <span className="whitespace-pre-wrap">
                        <MentionText body={m.body} names={names} />
                      </span>
                    )}

                    <span className="bubble-time">
                      {m.edited_at && <span className="mr-1 italic">edited</span>}
                      {clockTime(m.created_at)}
                    </span>
                  </div>

                  {m.editable && mine && (
                    <div className="msg-actions mt-0.5 pr-1">
                      <EditMessageForm action={editAction} messageId={m.id} body={m.body} />
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
          dropped={dropped}
          onDropConsumed={() => setDropped(null)}
          onSent={poll}
        />
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageRow } from '@/lib/chat-queries';
import type { FormState } from '@/lib/form-state';
import { formatBytes } from '@/lib/upload-types';
import { Avatar, clockTime, dayLabel, MentionText } from './ChatBits';
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
      className="relative flex min-h-0 flex-1 flex-col"
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
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/[0.06]">
          <p className="text-accent-deep font-semibold">Drop to attach</p>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <p className="hint py-10 text-center">
            Nothing here yet. The first message is below.
          </p>
        )}

        {messages.map((m, i) => {
          const day = dayLabel(m.created_at);
          const newDay = day !== lastDay;
          lastDay = day;
          const grouped = !newDay && sameGroup(messages[i - 1], m);
          const image = (m.file_mime ?? '').startsWith('image/');

          return (
            <div key={m.id}>
              {newDay && (
                <div className="my-4 flex items-center gap-3">
                  <span className="h-px flex-1 bg-void/10" />
                  <span className="chip tone-quiet">{day}</span>
                  <span className="h-px flex-1 bg-void/10" />
                </div>
              )}

              <div className={`flex gap-3 ${grouped ? 'mt-0.5' : 'mt-3'}`}>
                <div className="w-9 shrink-0">
                  {!grouped && <Avatar name={m.author_name} />}
                </div>

                <div className="min-w-0 flex-1">
                  {!grouped && (
                    <p className="leading-tight">
                      <span className="font-semibold">{m.author_name}</span>
                      <span className="hint"> · {clockTime(m.created_at)}</span>
                      {m.edited_at && <span className="hint"> · corrected</span>}
                    </p>
                  )}

                  <div className="prose-vixart whitespace-pre-wrap">
                    <MentionText body={m.body} names={names} />
                  </div>

                  {m.file_id && (
                    <div className="mt-1.5">
                      {/* Never a static path: the only way to the bytes is the
                          authenticated route, which re-checks who is asking. */}
                      {image ? (
                        <a href={`/api/files/${m.file_id}`} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/files/${m.file_id}`}
                            alt={m.file_name ?? 'Attachment'}
                            className="max-h-72 rounded-xl border border-void/10"
                          />
                        </a>
                      ) : (
                        <a
                          href={`/api/files/${m.file_id}`}
                          className="flex max-w-sm items-center gap-3 rounded-xl border border-void/15 px-3 py-2 hover:bg-void/[0.04]"
                        >
                          <span aria-hidden="true" className="text-void/35 text-lg">▤</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] font-medium">
                              {m.file_name}
                            </span>
                            <span className="hint text-[12px]">
                              {m.file_size ? formatBytes(Number(m.file_size)) : ''}
                              {m.file_mime ? ` · ${m.file_mime}` : ''}
                            </span>
                          </span>
                        </a>
                      )}
                    </div>
                  )}

                  {m.editable && m.author_id === meId && (
                    <div className="mt-0.5">
                      <EditMessageForm action={editAction} messageId={m.id} body={m.body} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <Composer
        action={postAction}
        mentionable={mentionable}
        dropped={dropped}
        onDropConsumed={() => setDropped(null)}
        onSent={poll}
      />
    </div>
  );
}

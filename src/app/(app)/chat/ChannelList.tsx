'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { subscribeToChat } from '@/lib/chat-stream-client';
import type { ChannelRow, DmRow } from '@/lib/chat-queries';
import { Avatar } from './ChatBits';
import { NewChannelForm } from './ChatForms';
import type { FormState } from '@/lib/form-state';

/**
 * The channel list: always there, on the left, like a workspace.
 *
 * Grouped the way the agency is: General, then the work, then the clients.
 * Unread is bold with a count — the one thing that has to be readable out of
 * the corner of an eye.
 *
 * It lives in the layout, so it is mounted once and survives moving between
 * channels. That is also why it polls rather than re-reading on navigation: a
 * layout is not re-rendered when only the channel below it changes.
 */

const GROUPS = [
  { kind: 'general', label: null },
  { kind: 'project', label: 'Projects' },
  { kind: 'company', label: 'Clients' },
  /*
   * Where the clients themselves write.
   *
   * Listed separately from the client channel of the same name, and it matters
   * which is which: one is the team talking ABOUT a client, the other is the
   * client reading every word. Two lines with the same company name in
   * different sections is the right amount of friction before typing.
   */
  { kind: 'support', label: 'From clients' },
] as const;

export function ChannelList({
  initial,
  canCreate,
  createAction,
  targets,
  dms,
}: {
  initial: ChannelRow[];
  canCreate: boolean;
  createAction: (state: FormState, formData: FormData) => Promise<FormState>;
  targets: ReadonlyArray<{ id: string; name: string; kind: 'company' | 'project' }>;
  /**
   * Everybody, in their own section below the channels and never mixed into
   * them. A DM posted into a client channel by mistake is the failure this
   * separation exists to prevent.
   *
   * Every colleague is here whether or not anything has been said, so a row may
   * carry no thread id yet — the link goes through /chat/with/<person>, which
   * opens the conversation on the way past.
   */
  dms: DmRow[];
}) {
  const [channels, setChannels] = useState(initial);
  const [conversations, setConversations] = useState(dms);
  const [opening, setOpening] = useState(false);
  /** Whether announcements are arriving. Decides the fallback interval only. */
  const [streaming, setStreaming] = useState(false);
  const params = useParams<{ id?: string }>();
  const openId = params?.id;

  // A navigation re-renders this with fresh server data; take it.
  useEffect(() => setConversations(dms), [dms]);

  // Nudged by the stream, and on a timer behind it. Thirty seconds without a
  // stream, two minutes with one, and nothing at all while the tab is hidden —
  // a browser with chat open in a background tab since Monday should cost the
  // server nothing.
  useEffect(() => {
    let alive = true;

    async function refresh() {
      if (document.hidden) return;
      try {
        const response = await fetch('/api/chat/channels', { cache: 'no-store' });
        if (!response.ok || !alive) return;
        const data = (await response.json()) as { channels: ChannelRow[]; dms: DmRow[] };
        if (!alive) return;
        setChannels(data.channels);
        setConversations(data.dms);
      } catch {
        // A poll that fails is a poll. The list on screen stays as it was.
      }
    }

    // Any thread at all: an unread badge is about the channels you are NOT
    // looking at, so this one does not filter by id.
    const unsubscribe = subscribeToChat({
      onChange: () => void refresh(),
      onReady: (mode) => {
        void refresh();
        setStreaming(mode === 'live');
      },
      onDrop: () => setStreaming(false),
    });

    const timer = setInterval(refresh, streaming ? 120_000 : 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [streaming]);

  // The channel you are looking at is not unread, whatever the last poll said.
  const shown = channels.map((c) => (c.id === openId ? { ...c, unread: 0 } : c));
  const shownDms = conversations.map((d) => (d.id === openId ? { ...d, unread: 0 } : d));

  return (
    <aside className="flex h-full w-full shrink-0 flex-col overflow-y-auto border-r border-void/10 bg-surface md:w-60 md:bg-void/[0.025]">
      <div className="flex items-center justify-between gap-2 px-4 pt-5 pb-3">
        <h2 className="display text-[15px] font-bold">Channels</h2>
        {canCreate && (
          <button
            type="button"
            onClick={() => setOpening((o) => !o)}
            aria-expanded={opening}
            className="cursor-pointer rounded-md px-1.5 text-[18px] leading-none text-void/45 hover:bg-void/10 hover:text-void"
            title="New channel"
          >
            +
          </button>
        )}
      </div>

      {opening && (
        <div className="px-3 pb-3">
          <NewChannelForm action={createAction} targets={targets} onDone={() => setOpening(false)} />
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {GROUPS.map(({ kind, label }) => {
          const inGroup = shown.filter((c) => c.kind === kind);
          if (inGroup.length === 0) return null;
          return (
            <div key={kind} className="mb-3">
              {label && (
                <p className="px-2.5 pt-3 pb-1 text-[11px] font-bold tracking-[0.1em] text-void/40 uppercase">
                  {label}
                </p>
              )}
              {inGroup.map((c) => {
                const active = c.id === openId;
                const unread = Number(c.unread) > 0;
                return (
                  <Link
                    key={c.id}
                    href={`/chat/${c.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={`mb-0.5 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[14px] ${
                      active
                        ? 'bg-accent font-semibold text-pure'
                        : unread
                          ? 'font-bold text-void hover:bg-void/[0.06]'
                          : 'text-void/70 hover:bg-void/[0.06]'
                    }`}
                  >
                    <span aria-hidden="true" className={active ? 'text-pure/60' : 'text-void/30'}>
                      #
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {unread && !active && (
                      <span className="bg-accent text-pure ml-1 inline-block min-w-[1.35rem] rounded-full px-1.5 py-px text-center text-[11.5px] font-bold">
                        {c.unread}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
        {/*
          Below the channels, never among them — and now everybody, not only the
          conversations that exist.

          The "+" button and its dropdown are gone. Choosing a name from a select
          before you could type was most of the reason a private message never
          got sent, for a team of eight who all know each other. A row per person
          is the list; the thread is opened by clicking it.
        */}
        <div className="mt-2 border-t border-void/10 pt-3">
          <p className="px-2.5 pb-1 text-[11px] font-bold tracking-[0.1em] text-void/40 uppercase">
            Private
          </p>

          {shownDms.length === 0 && (
            <p className="hint px-2.5 pb-2 text-[12.5px]">
              Nobody else on the team yet.
            </p>
          )}

          {shownDms.map((d) => {
            const active = d.id !== null && d.id === openId;
            const unread = Number(d.unread) > 0 && !active;
            /*
             * Two destinations, one appearance. A conversation that exists is
             * linked directly; one that does not goes through the route that
             * opens it. The row must not look different for the second case —
             * "you have never written to Adam" is not information worth a
             * different style, and it is the state every row starts in.
             */
            const href = d.id ? `/chat/${d.id}` : `/chat/with/${d.other_id}`;
            return (
              <Link
                key={d.other_id}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`mb-0.5 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[14px] ${
                  active
                    ? 'bg-accent font-semibold text-pure'
                    : unread
                      ? 'font-bold text-void hover:bg-void/[0.06]'
                      : 'text-void/70 hover:bg-void/[0.06]'
                }`}
              >
                <Avatar name={d.title} id={d.other_id} size={18} />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                {unread && (
                  <span className="bg-accent text-pure ml-1 inline-block min-w-[1.35rem] rounded-full px-1.5 py-px text-center text-[11.5px] font-bold">
                    {d.unread}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}

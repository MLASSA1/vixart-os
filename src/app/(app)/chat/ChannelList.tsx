'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ChannelRow } from '@/lib/chat-queries';
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
] as const;

export function ChannelList({
  initial,
  canCreate,
  createAction,
  targets,
}: {
  initial: ChannelRow[];
  canCreate: boolean;
  createAction: (state: FormState, formData: FormData) => Promise<FormState>;
  targets: ReadonlyArray<{ id: string; name: string; kind: 'company' | 'project' }>;
}) {
  const [channels, setChannels] = useState(initial);
  const [opening, setOpening] = useState(false);
  const params = useParams<{ id?: string }>();
  const openId = params?.id;

  // Thirty seconds, and nothing at all while the tab is hidden. A browser with
  // chat open in a background tab since Monday should cost the server nothing.
  useEffect(() => {
    let alive = true;

    async function refresh() {
      if (document.hidden) return;
      try {
        const response = await fetch('/api/chat/channels', { cache: 'no-store' });
        if (!response.ok || !alive) return;
        const data = (await response.json()) as { channels: ChannelRow[] };
        if (alive) setChannels(data.channels);
      } catch {
        // A poll that fails is a poll. The list on screen stays as it was.
      }
    }

    const timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  // The channel you are looking at is not unread, whatever the last poll said.
  const shown = channels.map((c) => (c.id === openId ? { ...c, unread: 0 } : c));

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-void/10 bg-void/[0.025]">
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
      </nav>
    </aside>
  );
}

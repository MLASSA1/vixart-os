'use client';

import { useRef, useState } from 'react';

/**
 * VIXART OS — the chat panel, shared by every agent.
 *
 * One component, parameterised by endpoint. The user never picks which agent to
 * address: the PAGE decides. Money questions are on /finance with Le Comptable,
 * work questions on /projects with Le Chef. That keeps the locked rule — no
 * sub-agent picker — while letting two different jobs have two different
 * readers.
 *
 * Whichever agent it is, the panel shows what was read under each answer, so a
 * figure can always be traced back to the tables behind it.
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: Array<{ name: string; input: Record<string, unknown> }>;
  sources?: Array<{ table: string; rows: number }>;
}

export interface AgentPanelProps {
  /** Where to POST. */
  endpoint: string;
  name: string;
  /** One line on what it does — and what it will not do. */
  blurb: string;
  suggestions: readonly string[];
  /** Tool name → what to call it in front of a human. */
  toolLabels: Readonly<Record<string, string>>;
  configured: boolean;
  /** Shown instead of the panel when there is no API key. */
  notConfiguredNote: string;
}

export function AgentPanel({
  endpoint,
  name,
  blurb,
  suggestions,
  toolLabels,
  configured,
  notConfiguredNote,
}: AgentPanelProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(question: string) {
    const text = question.trim();
    if (!text || pending) return;

    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setPending(true);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const payload = (await response.json()) as {
        reply?: string;
        toolsUsed?: Turn['toolsUsed'];
        sources?: Turn['sources'];
        error?: string;
      };

      if (!response.ok || payload.error) {
        setError(payload.error ?? 'That did not go through.');
        return;
      }
      setTurns([
        ...next,
        {
          role: 'assistant',
          content: payload.reply ?? '',
          toolsUsed: payload.toolsUsed,
          sources: payload.sources,
        },
      ]);
    } catch {
      setError('Could not reach the agent. Is the server still running?');
    } finally {
      setPending(false);
    }
  }

  if (!configured) {
    return (
      <div className="border border-dashed border-void/40 px-5 py-6">
        <p className="font-semibold">{name} is not configured</p>
        <p className="prose-vixart mt-2" style={{ opacity: 0.7 }}>
          {notConfiguredNote}
        </p>
      </div>
    );
  }

  return (
    <div className="border border-void/25">
      <div className="border-b border-void/15 px-5 py-3">
        <p className="font-semibold">{name}</p>
        <p className="hint mt-0.5">{blurb}</p>
      </div>

      <div className="max-h-[28rem] overflow-y-auto px-5 py-4">
        {turns.length === 0 ? (
          <div>
            <p className="hint">Ask it something:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="btn btn-inverse btn-small"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-5">
            {turns.map((turn, i) => (
              <li key={i}>
                {/* Speaker by weight and rule, never by colour. */}
                <p className="label">{turn.role === 'user' ? 'You' : name}</p>
                <div
                  className={
                    turn.role === 'user'
                      ? 'mt-1 border-l-2 border-void pl-3'
                      : 'prose-vixart mt-1 whitespace-pre-wrap'
                  }
                >
                  {turn.content}
                </div>

                {turn.sources && turn.sources.length > 0 && (
                  <p className="hint mt-2">
                    Read{' '}
                    {turn.sources
                      .map((s) => `${s.rows} ${s.table} row${s.rows === 1 ? '' : 's'}`)
                      .join(', ')}
                    {turn.toolsUsed && turn.toolsUsed.length > 0 && (
                      <>
                        {' · via '}
                        {turn.toolsUsed.map((t) => toolLabels[t.name] ?? t.name).join(', ')}
                      </>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {pending && <p className="hint mt-4">Working…</p>}

        {error && (
          <div className="mt-4 border-2 border-void bg-void px-4 py-3 text-pure">
            <p className="label">Not answered</p>
            <p className="mt-1">{error}</p>
          </div>
        )}
      </div>

      <form
        className="flex gap-2 border-t border-void/15 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(inputRef.current?.value ?? '');
        }}
      >
        <input
          ref={inputRef}
          className="input mt-0 flex-1"
          placeholder="Ask…"
          disabled={pending}
          aria-label={`Ask ${name}`}
        />
        <button type="submit" className="btn" disabled={pending}>
          {pending ? '…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}

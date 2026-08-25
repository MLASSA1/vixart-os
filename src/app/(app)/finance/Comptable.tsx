'use client';

import { useRef, useState } from 'react';

/**
 * Le Comptable — the chat panel.
 *
 * One agent, one surface. There is no sub-agent picker: the six tools are
 * things it calls, and which ones ran is shown under each answer so a figure
 * can always be traced back to the tables it came from.
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: Array<{ name: string; input: Record<string, unknown> }>;
  sources?: Array<{ table: string; rows: number }>;
}

const SUGGESTIONS = [
  'What came in this month?',
  'Who owes us, and how long has it been?',
  'What is due fiscally this quarter?',
  'What did we make on Bader Training Center?',
];

const TOOL_LABEL: Record<string, string> = {
  treasury: 'ledger',
  receivables: 'unpaid invoices',
  expenses: 'costs',
  calendar: 'fiscal calendar',
  margin: 'margin per client',
  draft_invoice: 'drafted an invoice',
};

export function Comptable({ configured }: { configured: boolean }) {
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
      const response = await fetch('/api/agent/chat', {
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
        <p className="font-semibold">Le Comptable is not configured</p>
        <p className="prose-vixart mt-2" style={{ opacity: 0.7 }}>
          Add <span className="code">ANTHROPIC_API_KEY</span> to <span className="code">.env</span>{' '}
          and restart the stack. Everything else on this screen works without it —
          the agent only ever reads what is already here.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-void/25">
      <div className="border-b border-void/15 px-5 py-3">
        <p className="font-semibold">Le Comptable</p>
        <p className="hint mt-0.5">
          Reads the books and cites its rows. It drafts; you sign. It cannot issue
          a number, move money, or file anything — the database refuses it.
        </p>
      </div>

      <div className="max-h-[28rem] overflow-y-auto px-5 py-4">
        {turns.length === 0 ? (
          <div>
            <p className="hint">Ask it something:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
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
                {/* Speaker by weight and rule, not by colour. */}
                <p className="label">{turn.role === 'user' ? 'You' : 'Le Comptable'}</p>
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
                        {turn.toolsUsed
                          .map((t) => TOOL_LABEL[t.name] ?? t.name)
                          .join(', ')}
                      </>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {pending && <p className="hint mt-4">Reading the books…</p>}

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
          placeholder="Ask about the money…"
          disabled={pending}
          aria-label="Ask Le Comptable"
        />
        <button type="submit" className="btn" disabled={pending}>
          {pending ? '…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}

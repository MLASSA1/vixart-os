'use client';

/**
 * The small pieces the chat panes share.
 */

/**
 * Initials, on a colour derived from the name.
 *
 * No upload flow, deliberately: profile pictures mean a second thing to store,
 * moderate, back up and serve, for eight people who already know each other by
 * name. The hue is a hash of the name, so the same person is the same colour on
 * everybody's screen without anything being stored anywhere.
 */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] font-semibold text-white select-none"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        backgroundColor: `hsl(${hash} 42% 42%)`,
      }}
    >
      {initials || '?'}
    </span>
  );
}

/**
 * A message body with the names picked out.
 *
 * Highlighted and nothing more — no link, because there is no profile page to
 * link to and a dead link that looks live is worse than plain text. The names
 * are matched against the people who can see this channel, so a stray "@" or
 * an email address in the text stays ordinary.
 */
export function MentionText({
  body,
  names,
}: {
  body: string;
  names: ReadonlyArray<string>;
}) {
  if (names.length === 0) return <>{body}</>;

  // Longest first, so "Mohamed Amine" wins over "Mohamed".
  const ordered = [...names].sort((a, b) => b.length - a.length);
  const escaped = ordered.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`@(${escaped.join('|')})\\b`, 'gi');

  const out: Array<string | React.ReactElement> = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body))) {
    if (match.index > last) out.push(body.slice(last, match.index));
    out.push(
      <span key={match.index} className="tone-accent rounded-[5px] px-1 font-semibold">
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < body.length) out.push(body.slice(last));

  return <>{out}</>;
}

/** "Today", "Yesterday", then the date. One divider per day of messages. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

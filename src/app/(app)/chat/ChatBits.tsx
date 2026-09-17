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
/**
 * One person, one colour — everywhere, for everyone, without storing anything.
 *
 * Keyed on the account id rather than the name. Hashing the name would have
 * been simpler and is what this did first, but it makes the colour a property
 * of the spelling: renaming Aymen to Yassin, which this system has already
 * done once, would have moved him to a different colour and quietly broken the
 * only thing the colour is for. An id does not change.
 *
 * Derived rather than stored, so there is no table to keep in step and no way
 * for two people to see different colours for the same colleague.
 */
export function hueFor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return hash;
}

export function Avatar({
  name,
  id,
  size = 36,
}: {
  name: string;
  /** The account. Falls back to the name only where no id is to hand. */
  id?: string;
  size?: number;
}) {
  /**
   * Two letters, always.
   *
   * One initial per word is the usual rule and it is useless here: the team is
   * Adam, Aya, Abdelkbir and Azzedine, so four of seven people would wear an
   * identical A. A single name therefore gives up its first two letters —
   * Ad, Ay, Ab, Az — which tells them apart at a glance.
   */
  const words = name.split(/\s+/).filter(Boolean);
  const initials = (
    words.length > 1
      ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')
      : (words[0] ?? '').slice(0, 2)
  ).toUpperCase();

  const hash = hueFor(id ?? name);

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

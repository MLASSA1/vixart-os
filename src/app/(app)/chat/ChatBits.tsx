'use client';

import { useState } from 'react';

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

  /**
   * The picture, when there is one.
   *
   * Amin asked for profile pictures, which reverses the note this component used
   * to carry — there was no upload flow on the grounds that eight people who know
   * each other by name do not need faces. They want them.
   *
   * INITIALS FIRST, PICTURE OVER THE TOP. The letters render immediately and are
   * replaced only once an image has actually loaded, so a person with no picture
   * shows nothing missing, a slow connection shows nothing blank, and a 404
   * shows nothing broken. The alternative — ask each screen whether this person
   * has a picture and pass it down — means a dozen queries carrying an extra
   * column, and the one that forgets shows initials for ever in a way that looks
   * deliberate.
   *
   * `id` is not always an app_user: a client writing in a support thread is
   * their contact id, and the route simply answers 404. That is the same answer
   * as "no picture" and needs no special case here.
   */
  const [shown, setShown] = useState(false);

  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] font-semibold text-white select-none"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        // 32% lightness: white initials clear 4.5:1 on every one of the 360
        // hues (worst 4.75, at yellow). At 42% the worst was 3.0. The inset ring
        // keeps the tile's shape where a deep blue would melt into a dark card.
        backgroundColor: `hsl(${hash} 45% 32%)`,
        boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.1)',
      }}
    >
      {!shown && <span>{initials || '?'}</span>}
      {id && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={`/api/avatar/${id}`}
          alt=""
          onLoad={() => setShown(true)}
          onError={() => setShown(false)}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ opacity: shown ? 1 : 0 }}
        />
      )}
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

/*
 * `dayLabel` and `clockTime` used to live here and formatted in the BROWSER,
 * in whatever zone and tz data the device had. They are gone on purpose: a
 * message now arrives with `time_label` and `day_key` made by the server, and
 * `dayHeading` in src/lib/format.ts turns a key into "Today". See the note
 * there for the hour it was wrong by.
 */

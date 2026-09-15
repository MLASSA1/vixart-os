/**
 * VIXART OS — finding the people named in a message.
 *
 * Parsed from the TEXT, on the server, against a list of people the server
 * worked out for itself. Never from a client-supplied list of ids: a form
 * field is a suggestion, and a suggestion is not an authorisation. The picker
 * in the browser writes "@Mohamed Amine" into the body; this reads it back.
 *
 * Names here have spaces, so a naive /@(\w+)/ finds "Mohamed" and stops. The
 * candidate list is matched longest-first instead, which means "@Mohamed Amine"
 * resolves to Mohamed Amine rather than to a Mohamed who does not exist.
 */

export interface MentionCandidate {
  id: string;
  fullName: string;
}

export interface MentionResult {
  /** People named who can see the thread. These get a notification. */
  matched: MentionCandidate[];
  /**
   * Names that looked like a mention and resolved to nobody reachable.
   *
   * Returned rather than swallowed: the author believes they notified
   * somebody, and a silent drop leaves them believing it.
   */
  unmatched: string[];
}

/** Escape a name for use inside a regular expression. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Who was named in this text.
 *
 * `candidates` must already be the people the AUTHOR can legitimately mention
 * into this thread — the caller works that out with the database's own
 * visibility rules. This function only reads text; it decides nothing about
 * who may see what.
 */
export function findMentions(body: string, candidates: MentionCandidate[]): MentionResult {
  if (!body.includes('@')) return { matched: [], unmatched: [] };

  const matched = new Map<string, MentionCandidate>();

  // Longest first, so "@Mohamed Amine" is not eaten by a shorter "@Mohamed".
  const byLength = [...candidates].sort((a, b) => b.fullName.length - a.fullName.length);

  // Blank out each match as it is found, so one "@" cannot be claimed twice.
  let remaining = body;

  for (const person of byLength) {
    const pattern = new RegExp(`@${escapeRegExp(person.fullName)}\\b`, 'i');
    if (pattern.test(remaining)) {
      matched.set(person.id, person);
      remaining = remaining.replace(new RegExp(`@${escapeRegExp(person.fullName)}\\b`, 'gi'), ' ');
      continue;
    }

    // A first name on its own, but only when it is unambiguous among the
    // people available. Two Mohameds and "@Mohamed" names nobody, rather than
    // guessing at one of them.
    const first = person.fullName.split(/\s+/)[0];
    if (!first) continue;
    const sharesFirstName = candidates.filter(
      (c) => c.fullName.split(/\s+/)[0]?.toLowerCase() === first.toLowerCase(),
    ).length;
    if (sharesFirstName !== 1) continue;

    const firstPattern = new RegExp(`@${escapeRegExp(first)}\\b`, 'i');
    if (firstPattern.test(remaining)) {
      matched.set(person.id, person);
      remaining = remaining.replace(new RegExp(`@${escapeRegExp(first)}\\b`, 'gi'), ' ');
    }
  }

  // Whatever "@word" is left resolved to nobody reachable.
  const unmatched = [...remaining.matchAll(/@([\p{L}][\p{L}\p{M}'-]*)/gu)]
    .map((m) => m[1])
    .filter((n): n is string => Boolean(n));

  return {
    matched: [...matched.values()],
    unmatched: [...new Set(unmatched)],
  };
}

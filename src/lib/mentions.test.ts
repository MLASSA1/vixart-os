import { describe, expect, it } from 'vitest';
import { findMentions, type MentionCandidate } from './mentions';

const TEAM: MentionCandidate[] = [
  { id: 'amin', fullName: 'Amin' },
  { id: 'mohamed', fullName: 'Mohamed Amine' },
  { id: 'aya', fullName: 'Aya' },
  { id: 'abdelkbir', fullName: 'Abdelkbir' },
];

describe('findMentions', () => {
  it('finds nobody in a message with no @', () => {
    const r = findMentions('the shoot is at seven', TEAM);
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched).toHaveLength(0);
  });

  it('matches a full name with a space in it', () => {
    const r = findMentions('@Mohamed Amine can you sign this off', TEAM);
    expect(r.matched.map((m) => m.id)).toEqual(['mohamed']);
    expect(r.unmatched).toHaveLength(0);
  });

  it('does not let a short name eat a longer one', () => {
    // The naive /@(\w+)/ would take "Mohamed" and leave "Amine" dangling.
    const r = findMentions('@Mohamed Amine', TEAM);
    expect(r.matched.map((m) => m.id)).toEqual(['mohamed']);
  });

  it('matches a first name when it is unambiguous', () => {
    const r = findMentions('@Aya can you draft the caption', TEAM);
    expect(r.matched.map((m) => m.id)).toEqual(['aya']);
  });

  it('refuses to guess when a first name is shared', () => {
    const twoAmins: MentionCandidate[] = [
      { id: 'a1', fullName: 'Amin Nait' },
      { id: 'a2', fullName: 'Amin Other' },
    ];
    const r = findMentions('@Amin look at this', twoAmins);
    expect(r.matched).toHaveLength(0);
    // Reported rather than dropped, so the author is told it landed nowhere.
    expect(r.unmatched).toContain('Amin');
  });

  it('finds several people in one message', () => {
    const r = findMentions('@Aya and @Abdelkbir — ready?', TEAM);
    expect(r.matched.map((m) => m.id).sort()).toEqual(['abdelkbir', 'aya']);
  });

  it('never names the same person twice', () => {
    const r = findMentions('@Aya @Aya @Aya', TEAM);
    expect(r.matched).toHaveLength(1);
  });

  it('reports a name that matches nobody reachable', () => {
    // Either they do not exist, or they cannot see this thread — the caller
    // decides which by what it puts in `candidates`.
    const r = findMentions('@Youssef can you help', TEAM);
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched).toEqual(['Youssef']);
  });

  it('is case-insensitive', () => {
    expect(findMentions('@aya', TEAM).matched.map((m) => m.id)).toEqual(['aya']);
  });

  it('does not treat an email address as a mention', () => {
    const r = findMentions('write to amin@vixart.ma about it', TEAM);
    // "@vixart" is not a person; nothing is matched and nothing is claimed.
    expect(r.matched).toHaveLength(0);
  });
});

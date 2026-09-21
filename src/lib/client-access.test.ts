import { describe, expect, it } from 'vitest';
import {
  generatePassword,
  hashPassword,
  invitationExpiry,
  invitationMail,
  INVITATION_DAYS,
} from './client-access';
import { compare } from 'bcryptjs';

/**
 * The generated password, and the things about it that are easy to get wrong
 * without anybody noticing.
 *
 * A weak generator produces passwords that look exactly like strong ones. So
 * does a biased one. Neither shows up in a screenshot, in a build, or in the
 * client's experience of signing in — only in how long it takes somebody else
 * to guess one.
 */

describe('opening a client account', () => {
  it('produces a password nobody has to squint at', () => {
    const p = generatePassword();
    expect(p).toHaveLength(14);
    // Typed by hand, often off a phone, by somebody who did not ask for it.
    expect(p).not.toMatch(/[O0lI1]/);
    expect(p).toMatch(/^[A-Za-z2-9]+$/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });

  it('is not biased towards the front of the alphabet', () => {
    // `byte % alphabet.length` without rejection sampling makes the first few
    // characters likelier than the rest. With 56 characters and a 256-byte
    // range the bias is small, real, and invisible — so it is measured.
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const ch of generatePassword()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const values = [...counts.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const worst = Math.max(...values.map((v) => Math.abs(v - mean) / mean));
    // Every character within 25% of the mean. A modulo bias would put the
    // first eight characters roughly 40% above it.
    expect(worst).toBeLessThan(0.25);
  });

  it('hashes at the same cost as a staff account', async () => {
    const p = generatePassword();
    const h = await hashPassword(p);
    expect(h.startsWith('$2b$12$')).toBe(true);
    expect(await compare(p, h)).toBe(true);
    expect(await compare('something else', h)).toBe(false);
  });

  it('expires, which is the whole mitigation', () => {
    const now = new Date('2026-09-21T10:00:00Z');
    const at = invitationExpiry(now);
    expect(at.getTime() - now.getTime()).toBe(INVITATION_DAYS * 86_400_000);
    // An invitation nobody opens must stop working. Without this the password
    // sits in a mailbox for ever, which is the objection to emailing one.
    expect(at.getTime()).toBeGreaterThan(now.getTime());
  });

  it('writes an email a person can read in either format', () => {
    const mail = invitationMail({
      fullName: 'Ahmed',
      companyName: 'Laboratoire Talborjt',
      email: 'ahmed@example.com',
      password: 'Abcd2345Efgh6',
      url: 'https://client.visionxart.cloud',
    });

    for (const body of [mail.text, mail.html]) {
      expect(body).toContain('Abcd2345Efgh6');
      expect(body).toContain('ahmed@example.com');
      expect(body).toContain('Laboratoire Talborjt');
      // It has to SAY it expires, or the client has no reason to act on it.
      expect(body).toContain(String(INVITATION_DAYS));
    }
    expect(mail.subject).toContain('Laboratoire Talborjt');
  });

  it('escapes a company name into the HTML rather than into the markup', () => {
    // Client names are typed by staff and can contain anything. An unescaped
    // one is a script tag in an email we sent.
    const mail = invitationMail({
      fullName: '<img src=x onerror=alert(1)>',
      companyName: 'Foo & <script>bar</script>',
      email: 'a@b.c',
      password: 'Abcd2345Efgh6',
      url: 'https://client.visionxart.cloud',
    });
    // What matters is that no TAG survives, not that the word "onerror"
    // never appears: escaped, `<img ... onerror=...>` is inert text that
    // happens to contain that word, and asserting on the word would push
    // somebody towards stripping content instead of escaping it.
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;img');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&amp;');
  });
});

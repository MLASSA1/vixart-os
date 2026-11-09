import { describe, expect, it } from 'vitest';
import { welcomeMailSubject, welcomeMailText, type Role } from './welcome-mail';

/**
 * The welcome a new account gets.
 *
 * The first test is the one that matters: no password, ever. The rest guard the
 * two ways this message can be wrong in a way nobody notices — pointing someone
 * at a section their role cannot open, and greeting them by the wrong part of
 * their name.
 */

const base = {
  fullName: 'Mailal Mariam',
  email: 'mrh.mailmrh2015@gmail.com',
  invitedBy: 'Amin',
};

const ROLES: Role[] = ['admin', 'moderator', 'member'];

describe('welcomeMailText', () => {
  it('never contains a password, whatever the role', () => {
    // A generated password is four groups of four from this alphabet. If one
    // ever gets interpolated in here, this catches its shape rather than one
    // literal value.
    const shape = /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/;
    for (const role of ROLES) {
      const text = welcomeMailText({ ...base, role });
      expect(text, `${role}: a password-shaped string is in the welcome email`)
        .not.toMatch(shape);
      expect(text.toLowerCase()).not.toContain('your password is');
      // It must still SAY where the password comes from, or the recipient has
      // no way to tell this message from a phishing attempt.
      expect(text.replace(/\s+/g, ' '))
        .toContain('Amin will send you your first password');
    }
  });

  it('tells them where to sign in, and which address to use', () => {
    const text = welcomeMailText({ ...base, role: 'admin' });
    expect(text).toContain('https://visionxart.cloud');
    expect(text).toContain('mrh.mailmrh2015@gmail.com');
    // Not the portal. A member of staff signing in there gets nowhere.
    expect(text).not.toContain('client.visionxart.cloud');
  });

  it('greets them by their first name', () => {
    expect(welcomeMailText({ ...base, role: 'member' })).toContain('Hi Mailal,');
    expect(welcomeMailText({ ...base, fullName: 'Amin', role: 'admin' }))
      .toContain('Hi Amin,');
    // A name with stray whitespace must not produce "Hi ,".
    expect(welcomeMailText({ ...base, fullName: '  Aya  ', role: 'member' }))
      .toContain('Hi Aya,');
  });

  it('points nobody at a section their role cannot open', () => {
    const member = welcomeMailText({ ...base, role: 'member' });
    expect(member, 'Finance is admin-only').not.toContain('Finance');
    expect(member, 'Quotes & invoices is admin-only').not.toContain('Quotes & invoices');
    expect(member, 'Dashboard is moderator and up').not.toContain('Dashboard');

    const moderator = welcomeMailText({ ...base, role: 'moderator' });
    expect(moderator).toContain('Dashboard');
    expect(moderator).not.toContain('Finance');
    expect(moderator).not.toContain('Quotes & invoices');

    const admin = welcomeMailText({ ...base, role: 'admin' });
    expect(admin).toContain('Finance');
    expect(admin).toContain('Quotes & invoices');
    // Everyone gets the sections everyone has.
    for (const text of [member, moderator, admin]) expect(text).toContain('My work');
  });

  it('warns an administrator about spending an invoice number', () => {
    // Whitespace-flattened: this asserts what the email SAYS, and the body is
    // hard-wrapped, so where a line happens to break must not fail a content
    // test. It did once — rewrapping the paragraph split the phrase in two.
    const flat = (role: Role) =>
      welcomeMailText({ ...base, role }).replace(/\s+/g, ' ');

    expect(flat('admin')).toContain('invoice number is spent');
    expect(flat('admin')).toContain('cannot be edited afterwards');
    // Not said to someone who cannot issue one — it would only confuse.
    expect(flat('member')).not.toContain('invoice number is spent');
  });

  it('wraps every line narrow enough for a mail client to show as written', () => {
    /*
     * This is plain text. Nothing re-flows it: a client shows the breaks that
     * are in it, and a phone shows them narrower still. The first version
     * built the opening paragraph by gluing a role sentence onto a fixed
     * sentence and produced a 120-character line, which was invisible in the
     * source and obvious the moment the message was printed and read.
     */
    for (const role of ROLES) {
      const long = welcomeMailText({ ...base, role })
        .split('\n')
        .filter((line) => line.length > 76);
      expect(long, `${role}: ${long.length} line(s) too long to read on a phone`)
        .toEqual([]);
    }
  });

  it('has a subject that says what it is', () => {
    expect(welcomeMailSubject()).toBe('Your VIXART OS account');
  });
});

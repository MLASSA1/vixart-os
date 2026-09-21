import 'server-only';
import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';

/**
 * Opening an account for a client.
 *
 * The password is generated here and emailed. That was Amin's decision, taken
 * with the objection on the table — an invite link that expires and lets them
 * choose their own would never put a working credential in a mailbox. Since it
 * is going to be emailed, the job of this file is to make the window as small
 * as it can be without changing his flow:
 *
 *   * generated from `crypto.randomBytes`, never `Math.random`;
 *   * bcrypt cost 12, the same as every staff account;
 *   * `must_change_password` set, so it buys one sign-in and nothing more;
 *   * and it EXPIRES. An invitation nobody opens stops working after a week,
 *     so a forgotten message in an inbox is not a permanent key to the
 *     account. This is the part that matters most.
 *
 * It is returned to the caller exactly once, to be put in the email, and never
 * stored anywhere but as a hash.
 */

/** How long a generated password is good for if it is never used. */
export const INVITATION_DAYS = 7;

/**
 * Ambiguous characters left out on purpose.
 *
 * This is read off a screen and typed by hand, often from a phone, by somebody
 * who did not ask for a password. `O`/`0` and `l`/`1`/`I` cost support time
 * and gain nothing: the length is where the strength is.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 14;

/** A password for one client account. ~81 bits of entropy. */
export function generatePassword(): string {
  // Rejection sampling rather than `% ALPHABET.length`, which would make the
  // first few characters of the alphabet slightly likelier than the rest.
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < LENGTH) {
    for (const byte of randomBytes(LENGTH)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === LENGTH) break;
    }
  }
  return out;
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, 12);
}

/** When a generated password stops working if it is never used. */
export function invitationExpiry(now = new Date()): Date {
  return new Date(now.getTime() + INVITATION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The invitation itself.
 *
 * Plain text as well as HTML: this lands in inboxes we know nothing about, and
 * a client whose mail client shows the raw source should still be able to read
 * their password rather than a wall of markup.
 */
export function invitationMail(input: {
  fullName: string;
  companyName: string;
  email: string;
  password: string;
  url: string;
}): { subject: string; text: string; html: string } {
  const subject = `Your VIXART account — ${input.companyName}`;

  const text = [
    `Hello ${input.fullName},`,
    '',
    `VIXART has opened an account for ${input.companyName}. You can sign in to see`,
    'your projects, follow how the work is going, and write to us directly.',
    '',
    `  Address:  ${input.url}`,
    `  Email:    ${input.email}`,
    `  Password: ${input.password}`,
    '',
    `This password works once and expires in ${INVITATION_DAYS} days. You will be asked`,
    'to choose your own the first time you sign in — please do not reply to this',
    'message with it, and delete this email once you are in.',
    '',
    'If you were not expecting this, tell us and we will close the account.',
    '',
    'SOCIETE VIXART SARL — Agadir',
  ].join('\n');

  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#17140F;line-height:1.55">
  <p>Hello ${escape(input.fullName)},</p>
  <p>VIXART has opened an account for <strong>${escape(input.companyName)}</strong>.
     You can sign in to see your projects, follow how the work is going, and write to us directly.</p>
  <table cellpadding="6" style="border-collapse:collapse;background:#F6F4EF;border-radius:8px">
    <tr><td style="opacity:.7">Address</td><td><a href="${escape(input.url)}">${escape(input.url)}</a></td></tr>
    <tr><td style="opacity:.7">Email</td><td>${escape(input.email)}</td></tr>
    <tr><td style="opacity:.7">Password</td><td><code style="font-size:16px">${escape(input.password)}</code></td></tr>
  </table>
  <p>This password works once and <strong>expires in ${INVITATION_DAYS} days</strong>. You will be asked
     to choose your own the first time you sign in — please do not reply to this message with it,
     and delete this email once you are in.</p>
  <p style="opacity:.7">If you were not expecting this, tell us and we will close the account.</p>
  <p style="opacity:.7">SOCIETE VIXART SARL — Agadir</p>
</div>`.trim();

  return { subject, text, html };
}

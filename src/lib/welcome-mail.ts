/**
 * VIXART OS — the message a new account gets, written once and sent by the app.
 *
 * WHY THIS EXISTS. For the system's first year, creating an account emailed
 * nobody. The password appeared on the administrator's screen and everything
 * after that — telling the person the system existed, where to sign in, what
 * their email address was — depended on somebody remembering to say it. On
 * 9 November 2026 an accountant was given a full administrator account and
 * heard nothing at all, because there was nothing to hear. The welcome that the
 * rest of the team got had been a script run by hand, months earlier, whose
 * recipient query skipped admins.
 *
 * NO PASSWORD IN HERE, AND THAT IS DELIBERATE. The first password is shown to
 * the administrator exactly once, on their own screen, and they pass it on by
 * hand. A password and the address it opens do not travel in the same message:
 * this one goes to a mailbox whose provider keeps a copy, through a relay that
 * keeps logs, and it can be forwarded by anyone who receives it. The email says
 * who to expect the password from instead, which is also how the recipient can
 * tell a real one from a phishing attempt.
 *
 * The body is built by a pure function so it can be read in a test, in a
 * script, or anywhere else, without a relay, a database or a network.
 * `sendWelcomeMail` is the only part that touches the outside world, and it
 * imports the relay WHERE IT USES IT rather than at the top of the file:
 * `mailer` is `server-only`, and importing it up here made the pure function
 * unimportable outside a server component — including from a one-line script
 * to read what the app is about to send somebody.
 */

import { appUrl } from '@/lib/vixart';

export type Role = 'admin' | 'moderator' | 'member';

export interface WelcomePerson {
  fullName: string;
  email: string;
  role: Role;
  /** Who will send the password. Named so a real mail is tellable from a fake. */
  invitedBy: string;
}

/**
 * What to look at first, by role.
 *
 * Only ever sections the person can actually open — a welcome that points an
 * editor at Finance teaches them the app is broken. The gates here are the same
 * ones the navigation uses (`minRole` in Shell.tsx); if a section moves between
 * roles there, it moves here.
 */
function firstStops(role: Role): string {
  const team = [
    '  Chat                A channel for every project and every client,',
    '                      already set up. Voice notes, dragged-in files, and',
    '                      @ to mention someone, which notifies them.',
    '',
    '  My work             The tasks that are yours, and what is due.',
    '',
    '  Prep                Where a video is planned before it is assigned.',
    '                      Private while you write it, shared when you are ready.',
  ].join('\n');

  if (role === 'member') return team;

  const commerce = [
    '  Clients             Each company, with its ICE, IF and RC on file.',
    '',
    '  Projects & Deals    What we are building, for whom, and what is still',
    '                      being won.',
    '',
    '  Dashboard           The company month by month.',
  ].join('\n');

  if (role === 'moderator') return `${commerce}\n\n${team}`;

  return [
    '  Quotes & invoices   Every quote and invoice, with its number, its',
    '                      client, what was billed and how it was paid. A',
    '                      draft can be printed as a PDF before it is issued.',
    '',
    '  Finance             What has been invoiced, what has been collected,',
    '                      and what is still owed.',
    '',
    commerce,
    '',
    team,
  ].join('\n');
}

/** The one rule an administrator must know before touching a document. */
function cautions(role: Role): string {
  if (role !== 'admin') return '';
  return `
Two things worth knowing before you issue anything. An invoice number
is spent the moment a document is issued and cannot be reused, so print
the draft and check it first. And an issued invoice cannot be edited
afterwards, by anyone, which is the point of it.
`;
}

/**
 * Hard-wrapped at roughly 72 columns, on purpose.
 *
 * This is a plain-text email. Nothing downstream re-flows it: a mail client
 * shows the line breaks that are in it, and a phone shows them narrower still.
 * The first draft built this paragraph by gluing a role sentence onto a fixed
 * opening, which produced a 120-character line that only became obvious when
 * the message was printed and read. So each block carries its own breaks and
 * is never concatenated mid-sentence.
 */
const WHAT_IT_IS: Record<Role, string> = {
  admin:
    "It is where the agency's work, its clients and its money all live,\n" +
    'and your account is an administrator one, so nothing in it is hidden\n' +
    'from you.',
  moderator:
    "It is where the agency's work and its clients live, and you can assign\n" +
    'work and sign it off.',
  member:
    'It replaces the scattered notes, chats and spreadsheets with one place\n' +
    'for the work.',
};

export function welcomeMailSubject(): string {
  return 'Your VIXART OS account';
}

export function welcomeMailText(p: WelcomePerson): string {
  const firstName = p.fullName.trim().split(/\s+/)[0] ?? p.fullName;

  return `Hi ${firstName},

You have an account on VIXART OS, the agency's own system.
${WHAT_IT_IS[p.role]}

Sign in at   ${appUrl()}
Your email   ${p.email}

${p.invitedBy} will send you your first password separately — a password is
never put in an email. The app asks you to choose your own the moment you
sign in, so the one you are sent stops working straight away.

What you will probably want first:

${firstStops(p.role)}
${cautions(p.role)}
If anything looks wrong or missing, tell ${p.invitedBy}.

— VIXART
`;
}

/**
 * Sends it, and returns what went wrong rather than throwing.
 *
 * The account has already been created by the time this runs. A relay that is
 * down, a mistyped address, an SMTP password that expired — none of those are
 * reasons to lose the account or to make the administrator do it again, and
 * none of them may be swallowed either: the caller shows the problem next to
 * the password so whoever created the account knows to say it by hand.
 */
export async function sendWelcomeMail(p: WelcomePerson): Promise<string | null> {
  try {
    const { sendMail } = await import('@/lib/mailer');
    await sendMail({
      to: p.email,
      subject: welcomeMailSubject(),
      text: welcomeMailText(p),
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'The welcome email could not be sent.';
  }
}

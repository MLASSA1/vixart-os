import 'server-only';
import { Client } from 'pg';
import { sendMail, mailerConfigured } from './mailer';

/**
 * Notifications that also arrive in a mailbox.
 *
 * Amin asked for an email when a task is assigned and an email for a private
 * message. This is the sweep that sends them.
 *
 * WHY A SWEEP AND NOT A SEND AT THE POINT OF THE EVENT.
 *
 * Notifications are created by database triggers, because a task can be
 * assigned from four screens and a notification that relies on somebody
 * remembering to call it will be missed from the fourth. A trigger has no
 * network. An email sent inside the transaction instead would hold somebody's
 * write open on a remote mail server, and would vanish if the transaction rolled
 * back — the two failure modes nobody wants on the write that matters.
 *
 * So the notification row is the outbox: `emailed_at`, `email_attempts` and
 * `email_last_attempt_at` (0070). This claims a batch, sends, and stamps. The
 * worst case is a late email rather than a lost one or a blocked write.
 *
 * ON THE OWNER CONNECTION, on purpose. There is no signed-in person here, so
 * there is no identity for the application role's policies to evaluate — a
 * notification belongs to its recipient and this is nobody. The owner connection
 * is what every scheduled job in this project uses for exactly that reason.
 */

/**
 * The kinds that are worth a mailbox.
 *
 * Short, and it should stay short. Everything else in the inbox is something
 * you see when you next look, which is the point of an inbox: `task_overdue`
 * fires nightly and would become a daily reminder nobody reads, and
 * `task_awaiting_signoff` goes to whoever is already looking at the board.
 *
 * These three are the ones where the person is somewhere else and the thing is
 * waiting: work handed to you, a colleague writing to you, a client writing in.
 */
export const EMAILABLE_KINDS = [
  'task_assigned',
  /*
   * The notification that replaced the sign-off gate (0075).
   *
   * A member marks their own work finished now, and Amin asked to be told. It
   * has to be email and not only an inbox row for the same reason as an
   * assignment: the person who needs to know is somewhere else.
   *
   * Deduplicated in the database — `notification_one_per_state` covers
   * task_completed — so a task completed, reopened and completed again is one
   * email rather than three.
   */
  'task_completed',
  'message_received',
  'client_message',
] as const;

/**
 * How long a conversation waits between emails.
 *
 * A direct message keeps ONE standing notification per conversation, and a new
 * message bumps it and clears its mail state (0070) — so without a gap a rapid
 * exchange would be an email per line. Ten minutes means the first message goes
 * straight out and the rest of the burst arrives as one.
 *
 * Applied to conversations only. A task assignment is a discrete event and
 * should never be held back.
 */
const CONVERSATION_GAP = '10 minutes';

/**
 * Nothing older than this is ever emailed.
 *
 * The guard against the worst first run: the day this is switched on, every
 * notification in the table is unsent by definition. Without this, turning the
 * feature on would send the team a year of history in one batch — which is both
 * useless and the kind of thing that gets a domain marked as spam.
 */
const MAX_AGE = '24 hours';

/** Attempts before a row is left alone, visible, in the table. */
const MAX_ATTEMPTS = 3;

/** One batch. Small: this runs often, and a 1-core box shares itself. */
const BATCH = 20;

interface Pending {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string;
  actor_name: string | null;
  email: string;
  full_name: string;
}

/** Where a link in an email should point. */
function appUrl(): string {
  return (process.env.APP_URL ?? 'https://visionxart.cloud').replace(/\/$/, '');
}

/** The subject and text of one notification, by kind. */
export function composeNotificationMail(n: {
  kind: string;
  title: string;
  body: string | null;
  link: string;
  actor_name: string | null;
  full_name: string;
}): { subject: string; text: string; html: string } {
  const url = `${appUrl()}${n.link}`;
  const first = (n.full_name ?? '').split(/\s+/)[0] || 'there';

  let subject: string;
  let opening: string;

  switch (n.kind) {
    case 'task_assigned':
      subject = `New work: ${n.title}`;
      opening = n.actor_name
        ? `${n.actor_name} has assigned you a task.`
        : 'You have been assigned a task.';
      break;
    case 'task_completed':
      subject = `Finished: ${n.title}`;
      opening = n.body ?? 'A task has been marked finished.';
      break;
    case 'message_received':
      subject = `${n.title} sent you a message`;
      opening = `${n.title} wrote to you in VIXART OS.`;
      break;
    case 'client_message':
      subject = `${n.title} wrote in — client message`;
      opening = `${n.title} has written in their support conversation.`;
      break;
    default:
      subject = n.title;
      opening = 'There is something waiting for you in VIXART OS.';
  }

  /*
   * Plain text as well as HTML, and the plain text is written to be read. This
   * lands in mailboxes we know nothing about — a phone lock screen, a client
   * that strips markup — and the preview line is often the whole message
   * somebody sees.
   */
  const lines = [
    `Hello ${first},`,
    '',
    opening,
    '',
    n.kind === 'task_assigned' ? n.title : (n.body ?? ''),
    n.kind === 'task_assigned' && n.body ? `Project: ${n.body}` : '',
    '',
    `Open it here: ${url}`,
    '',
    '—',
    'VIXART OS',
  ].filter((l, i, all) => !(l === '' && all[i - 1] === ''));

  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = [
    `<p>Hello ${escape(first)},</p>`,
    `<p>${escape(opening)}</p>`,
    n.kind === 'task_assigned'
      ? `<p style="font-weight:600">${escape(n.title)}</p>` +
        (n.body ? `<p style="opacity:.7">${escape(n.body)}</p>` : '')
      : n.body
        ? `<blockquote style="margin:0;padding:0 0 0 12px;border-left:2px solid #ddd;opacity:.8">${escape(n.body)}</blockquote>`
        : '',
    `<p><a href="${url}">Open it in VIXART OS</a></p>`,
    `<p style="opacity:.55;font-size:13px">VIXART OS</p>`,
  ].join('\n');

  return { subject, text: lines.join('\n'), html };
}

/**
 * Claim a batch, send it, stamp what went.
 *
 * `FOR UPDATE SKIP LOCKED` and claiming with the same statement that reads:
 * two sweeps running at once — a restart overlapping, or a second container —
 * take different rows rather than the same person receiving everything twice.
 */
export async function sweepNotificationMail(): Promise<{
  sent: number;
  failed: number;
}> {
  if (!mailerConfigured()) return { sent: 0, failed: 0 };

  const url = process.env.DATABASE_URL;
  if (!url) return { sent: 0, failed: 0 };

  const db = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await db.connect();

  let claimed: Pending[] = [];
  try {
    const { rows } = await db.query<Pending>(
      `
      WITH due AS (
        SELECT n.id
          FROM notification n
          JOIN app_user u ON u.id = n.recipient_id
         WHERE n.emailed_at IS NULL
           AND n.email_attempts < $2
           AND n.kind = ANY($1::text[])
           AND n.created_at > now() - interval '${MAX_AGE}'
           AND u.is_active AND NOT u.is_service_account
           AND coalesce(trim(u.email), '') <> ''
           -- The gap, for conversations only. A task assignment never waits.
           AND (n.kind = 'task_assigned'
                OR n.email_last_attempt_at IS NULL
                OR n.email_last_attempt_at < now() - interval '${CONVERSATION_GAP}')
         ORDER BY n.created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      UPDATE notification n
         SET email_attempts = n.email_attempts + 1,
             email_last_attempt_at = now()
       WHERE n.id IN (SELECT id FROM due)
      RETURNING n.id, n.kind, n.title, n.body, n.link,
                n.actor_name,
                (SELECT u.email FROM app_user u WHERE u.id = n.recipient_id) AS email,
                (SELECT u.full_name FROM app_user u WHERE u.id = n.recipient_id) AS full_name
      `,
      [[...EMAILABLE_KINDS], MAX_ATTEMPTS, BATCH],
    );
    claimed = rows;
  } catch (error) {
    await db.end();
    throw error;
  }

  const sent: string[] = [];
  let failed = 0;

  for (const n of claimed) {
    try {
      const mail = composeNotificationMail(n);
      await sendMail({ to: n.email, ...mail });
      sent.push(n.id);
    } catch (error) {
      // Left claimed with its attempt counted, so it is retried and then
      // abandoned rather than retried for ever.
      failed += 1;
      console.error(
        `[notification-mail] ${n.kind} to ${n.email} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (sent.length > 0) {
    await db.query(`UPDATE notification SET emailed_at = now() WHERE id = ANY($1::uuid[])`, [sent]);
  }

  await db.end();
  return { sent: sent.length, failed };
}

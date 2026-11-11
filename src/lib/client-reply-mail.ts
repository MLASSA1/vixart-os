import { Client } from 'pg';
import { mailerConfigured, sendMail } from './mailer';

/**
 * Telling a client the team has replied (0088).
 *
 * The database writes the outbox (`client_reply_mail`, by trigger); this reads
 * it, sends, and stamps — the same pattern, and the same process, as the team's
 * own notification emails (notification-mail.ts). A send never runs inside the
 * transaction that wrote the reply.
 *
 * WHEN IT SENDS, AND WHEN IT DOES NOT.
 *
 *   * Not straight away. A row waits until the conversation has been quiet for
 *     QUIET; a reply typed in three messages becomes one email saying "3 new
 *     messages", and a client who is in the portal reading as we write is not
 *     emailed about what they are already looking at.
 *   * Not at all if they read it first. Before claiming anything the sweep
 *     marks as skipped every row whose replies the client has since opened in
 *     the portal (client_thread_read, 0087).
 *   * Not if they turned it off, or their account was closed — checked again
 *     here, at send time, not only when the row was written.
 *   * Never more than a day late: the guard against a first run, or a mailer
 *     that was down for a week, sending stale news.
 *
 * ON THE OWNER CONNECTION, like every scheduled job here: there is no signed-in
 * person for the application role's policies to evaluate.
 */

const QUIET = '3 minutes';
const MAX_AGE = '24 hours';
const MAX_ATTEMPTS = 3;
const RETRY_GAP = '10 minutes';
const BATCH = 20;

export interface ClientReply {
  id: string;
  email: string;
  full_name: string;
  company_name: string;
  author_name: string | null;
  preview: string;
  replies: number;
}

function portalUrl(): string {
  return (process.env.PORTAL_URL ?? 'https://client.visionxart.cloud').replace(/\/$/, '');
}

/** The email itself. Plain text first: it is often read as a lock-screen preview. */
export function clientReplyMail(r: Pick<ClientReply, 'full_name' | 'company_name' | 'author_name' | 'preview' | 'replies'>, url = `${portalUrl()}/portal/support`): { subject: string; text: string; html: string } {
  const first = (r.full_name ?? '').trim().split(/\s+/)[0] || 'there';
  const who = r.author_name?.trim() || 'The VIXART team';
  const subject = r.replies > 1
    ? `${r.replies} new messages from VIXART`
    : `${who} replied to you — VIXART`;
  const opening = r.replies > 1
    ? `${who} and the team have written to you ${r.replies} times about ${r.company_name}. The latest:`
    : `${who} has replied in your conversation with VIXART:`;

  const text = [
    `Hello ${first},`,
    '',
    opening,
    '',
    `  “${r.preview}”`,
    '',
    `Read and reply here: ${url}`,
    '',
    'You can turn these emails off from your Account page.',
    '',
    'SOCIETE VIXART SARL — Agadir',
  ].join('\n');

  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#0b0b0f;line-height:1.55">
  <p>Hello ${escape(first)},</p>
  <p>${escape(opening)}</p>
  <blockquote style="margin:0;padding:4px 0 4px 14px;border-left:2px solid #0b0b0f">${escape(r.preview)}</blockquote>
  <p><a href="${escape(url)}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#0b0b0f;color:#ffffff;text-decoration:none;border-top-left-radius:16px">Read and reply</a></p>
  <p style="opacity:.6;font-size:13px">You can turn these emails off from your Account page.</p>
  <p style="opacity:.6;font-size:13px">SOCIETE VIXART SARL — Agadir</p>
</div>`.trim();

  return { subject, text, html };
}

/**
 * Skip what has been read, claim what is due, send it, stamp it.
 *
 * `send` and `configured` are parameters so the integration test can run the
 * real queries against the test database without a mail server.
 */
export async function sweepClientReplyMail(options?: {
  send?: (mail: { to: string; subject: string; text: string; html: string }) => Promise<unknown>;
  configured?: boolean;
}): Promise<{ sent: number; failed: number; skipped: number }> {
  const configured = options?.configured ?? mailerConfigured();
  const send = options?.send ?? sendMail;
  const url = process.env.DATABASE_URL;
  if (!configured || !url) return { sent: 0, failed: 0, skipped: 0 };

  const db = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await db.connect();
  try {
    // Read in the portal since the last reply, or switched off since: nothing to send.
    const skipped = await db.query(`
      UPDATE client_reply_mail m SET skipped_at = now()
       WHERE m.emailed_at IS NULL AND m.skipped_at IS NULL
         AND (EXISTS (SELECT 1 FROM client_thread_read r
                       WHERE r.contact_id = m.contact_id AND r.thread_id = m.thread_id
                         AND r.last_read_at >= m.last_reply_at)
              OR NOT EXISTS (SELECT 1 FROM client_account ca
                              WHERE ca.contact_id = m.contact_id
                                AND ca.is_active AND ca.email_replies))
    `);

    const { rows } = await db.query<ClientReply>(`
      WITH due AS (
        SELECT m.id
          FROM client_reply_mail m
          JOIN contact ct ON ct.id = m.contact_id
          JOIN company co ON co.id = ct.company_id
         WHERE m.emailed_at IS NULL AND m.skipped_at IS NULL
           AND m.last_reply_at < now() - interval '${QUIET}'
           AND m.first_reply_at > now() - interval '${MAX_AGE}'
           AND m.email_attempts < $1
           AND (m.email_last_attempt_at IS NULL OR m.email_last_attempt_at < now() - interval '${RETRY_GAP}')
           AND co.archived_at IS NULL
           AND coalesce(btrim(ct.email), '') <> ''
         ORDER BY m.last_reply_at
         LIMIT $2
         FOR UPDATE OF m SKIP LOCKED
      )
      UPDATE client_reply_mail m
         SET email_attempts = m.email_attempts + 1, email_last_attempt_at = now()
        FROM contact ct JOIN company co ON co.id = ct.company_id
       WHERE m.id IN (SELECT id FROM due) AND ct.id = m.contact_id
      RETURNING m.id, ct.email, ct.full_name, co.name AS company_name,
                m.author_name, m.preview, m.replies
    `, [MAX_ATTEMPTS, BATCH]);

    const sent: string[] = [];
    let failed = 0;
    for (const r of rows) {
      try {
        await send({ to: r.email, ...clientReplyMail(r) });
        sent.push(r.id);
      } catch (error) {
        // Left with its attempt counted: retried after RETRY_GAP, then abandoned.
        failed += 1;
        console.error('[client-reply-mail] failed:', error instanceof Error ? error.message : error);
      }
    }
    if (sent.length > 0) {
      await db.query(`UPDATE client_reply_mail SET emailed_at = now() WHERE id = ANY($1::uuid[])`, [sent]);
    }
    return { sent: sent.length, failed, skipped: skipped.rowCount ?? 0 };
  } finally {
    await db.end();
  }
}

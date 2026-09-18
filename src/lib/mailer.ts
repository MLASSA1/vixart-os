import 'server-only';

/**
 * VIXART OS — sending email. SERVER ONLY.
 *
 * This and web push are the only things in the system that contact the outside
 * world. That was forbidden outright until 18 September 2026, when the rule was
 * lifted deliberately so that notifications could reach somebody who is not
 * sitting in front of the app.
 *
 * Configuration is read from the environment and nothing is guessed. With no
 * password set, `sendMail` refuses and says so — it does not quietly do
 * nothing, because a notification system that silently fails to notify is
 * worse than one that is obviously switched off.
 *
 * Mail goes out through Hostinger's SMTP, which is where visionxart.com's MX
 * records already point. The domain's SPF record authorises both that relay
 * and this VPS, so mail sent this way is not arriving unauthenticated.
 */

import nodemailer, { type Transporter } from 'nodemailer';

export interface MailerConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/** Defaults describe Hostinger; only the password has no sensible default. */
export function mailerConfig(): MailerConfig {
  return {
    host: process.env.SMTP_HOST ?? 'smtp.hostinger.com',
    // 465 is implicit TLS, which Hostinger prefers. 587 is STARTTLS.
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER ?? 'contact@visionxart.com',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.MAIL_FROM ?? 'VIXART OS <contact@visionxart.com>',
  };
}

/** Whether mail can be sent at all. The password is the only missing piece. */
export function mailerConfigured(): boolean {
  return mailerConfig().password.trim().length > 0;
}

let cached: Transporter | null = null;

function transport(): Transporter {
  if (cached) return cached;
  const c = mailerConfig();
  cached = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,
    auth: { user: c.user, pass: c.password },
  });
  return cached;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends one message. Throws with something a person can act on.
 *
 * Deliberately NOT swallowing failures: the caller decides whether a failed
 * send is worth retrying, and the notification stays marked undelivered so the
 * worker tries it again rather than losing it.
 */
export async function sendMail(mail: Mail): Promise<string> {
  const c = mailerConfig();
  if (!c.password.trim()) {
    throw new Error(
      'SMTP_PASSWORD is not set, so no mail can be sent. Set it in .env on the ' +
        'server (never on a command line — it ends up in shell history).',
    );
  }

  const info = await transport().sendMail({
    from: c.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
  });

  return String(info.messageId ?? '');
}

/** Proves the credentials and the relay, without sending anything. */
export async function verifyMailer(): Promise<void> {
  if (!mailerConfig().password.trim()) throw new Error('SMTP_PASSWORD is not set.');
  await transport().verify();
}

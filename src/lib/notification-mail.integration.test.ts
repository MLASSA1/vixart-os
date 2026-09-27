import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * WHICH notifications the mail sweep picks up.
 *
 * The sending is nodemailer's business and the composing is unit-tested. This is
 * about the selection, which is where the expensive mistakes live — every one of
 * them a mistake you make once, in production, to eight real mailboxes:
 *
 *   * no age limit and switching this on emails the entire history of the table
 *     in one batch, which is useless and is how a domain gets marked as spam;
 *   * no gap and a rapid exchange of direct messages is an email per line;
 *   * no attempt cap and one dead address is retried for ever;
 *   * and a kind that should never be emailed — `task_overdue` fires nightly —
 *     becomes a daily reminder nobody reads.
 *
 * The query under test is the one in `sweepNotificationMail`, duplicated here
 * with the same predicates. That is a copy, and normally I would refuse to test
 * a copy — but the real function sends email as its second act, and the thing
 * worth pinning down is the WHERE. The guard against drift is the last test in
 * this file, which reads the source and checks the predicates still match.
 */

const URL = process.env.DATABASE_URL;
const MARK = 'ZZZ mail sweep probe';

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

/** The selection, exactly as the sweep asks it — without the claiming UPDATE. */
const DUE = `
  SELECT n.id, n.kind
    FROM notification n
    JOIN app_user u ON u.id = n.recipient_id
   WHERE n.emailed_at IS NULL
     AND n.email_attempts < 3
     AND n.kind = ANY($1::text[])
     AND n.created_at > now() - interval '24 hours'
     AND u.is_active AND NOT u.is_service_account
     AND coalesce(trim(u.email), '') <> ''
     AND (n.kind = 'task_assigned'
          OR n.email_last_attempt_at IS NULL
          OR n.email_last_attempt_at < now() - interval '10 minutes')
     AND n.body LIKE $2
   ORDER BY n.created_at
`;

const KINDS = ['task_assigned', 'message_received', 'client_message'];

describe.skipIf(!HAS_DB)('the notification mail sweep picks the right rows (integration)', () => {
  let db: Client;
  let person = '';

  async function raise(opts: {
    kind: string;
    body: string;
    ageHours?: number;
    attempts?: number;
    emailed?: boolean;
    lastAttemptMinutes?: number;
  }): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO notification
         (recipient_id, kind, title, body, link, created_at,
          email_attempts, emailed_at, email_last_attempt_at)
       VALUES ($1,$2,$3,$4,'/my-work',
               now() - make_interval(hours => $5),
               $6,
               CASE WHEN $7 THEN now() ELSE NULL END,
               CASE WHEN $8::int IS NULL THEN NULL
                    ELSE now() - make_interval(mins => $8::int) END)
       RETURNING id`,
      [person, opts.kind, `${MARK} title`, opts.body, opts.ageHours ?? 0,
       opts.attempts ?? 0, opts.emailed ?? false, opts.lastAttemptMinutes ?? null],
    );
    return rows[0]!.id;
  }

  const due = async (): Promise<string[]> =>
    (await db.query<{ kind: string }>(DUE, [KINDS, `${MARK}%`])).rows.map((r) => r.kind);

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
    person = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account AND coalesce(trim(email),'') <> ''
        ORDER BY created_at LIMIT 1`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (db) {
      await db.query("SET app.bootstrap = 'on'");
      await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
      await db.end();
    }
  });

  it('takes a fresh assignment and a fresh message', async () => {
    await raise({ kind: 'task_assigned', body: `${MARK} a` });
    await raise({ kind: 'message_received', body: `${MARK} b` });
    expect((await due()).sort()).toEqual(['message_received', 'task_assigned']);
  });

  it('leaves anything already sent alone', async () => {
    await db.query(`UPDATE notification SET emailed_at = now() WHERE body LIKE $1`, [`${MARK}%`]);
    expect(await due()).toEqual([]);
  });

  it('never emails a backlog', async () => {
    await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
    // The day this was switched on, every row in the table was unsent by
    // definition. Without the window, that is the whole history in one batch.
    await raise({ kind: 'task_assigned', body: `${MARK} old`, ageHours: 30 });
    await raise({ kind: 'task_assigned', body: `${MARK} new`, ageHours: 1 });
    expect(await due()).toEqual(['task_assigned']);
  });

  it('gives up after three attempts', async () => {
    await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
    await raise({ kind: 'task_assigned', body: `${MARK} dead`, attempts: 3 });
    expect(await due(), 'a failing address is retried for ever').toEqual([]);
  });

  it('holds a conversation back until the gap has passed', async () => {
    await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
    // Bumped two minutes after its last email: a burst of messages, which must
    // arrive as one email and not as one per line.
    await raise({ kind: 'message_received', body: `${MARK} burst`, lastAttemptMinutes: 2 });
    expect(await due()).toEqual([]);

    await db.query(
      `UPDATE notification SET email_last_attempt_at = now() - interval '11 minutes'
        WHERE body LIKE $1`, [`${MARK}%`]);
    expect(await due(), 'a conversation never emails again after the first time').toEqual(['message_received']);
  });

  it('never holds a task assignment back', async () => {
    await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
    // A discrete event, not a conversation. Waiting ten minutes to tell somebody
    // they have been given work is the opposite of the point.
    await raise({ kind: 'task_assigned', body: `${MARK} urgent`, lastAttemptMinutes: 1 });
    expect(await due()).toEqual(['task_assigned']);
  });

  it('ignores kinds that are not emailable', async () => {
    await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
    await raise({ kind: 'task_overdue', body: `${MARK} nightly` });
    await raise({ kind: 'task_awaiting_signoff', body: `${MARK} board` });
    await raise({ kind: 'mentioned', body: `${MARK} named` });
    expect(await due(), 'a nightly reminder is being emailed').toEqual([]);
  });

  it('still has the same predicates in the real sweep', async () => {
    /*
     * The anti-drift check, because everything above tests a copy of the query.
     * If the real one changes shape, this fails and whoever changed it updates
     * both — which is the honest version of testing a duplicated WHERE.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'src/lib/notification-mail.ts'), 'utf8');

    for (const predicate of [
      'n.emailed_at IS NULL',
      'n.email_attempts < $2',
      "n.kind = ANY($1::text[])",
      "n.created_at > now() - interval '${MAX_AGE}'",
      "n.kind = 'task_assigned'",
      "n.email_last_attempt_at < now() - interval '${CONVERSATION_GAP}'",
      "coalesce(trim(u.email), '') <> ''",
      'FOR UPDATE SKIP LOCKED',
    ]) {
      expect(source, `the sweep no longer contains: ${predicate}`).toContain(predicate);
    }
    // And the three constants this file assumes.
    expect(source).toContain("const CONVERSATION_GAP = '10 minutes'");
    expect(source).toContain("const MAX_AGE = '24 hours'");
    expect(source).toContain('const MAX_ATTEMPTS = 3');
  });

  it('counts a failed send without marking it delivered', async () => {
    /*
     * The outbox's whole job. A mail host that refuses the connection must leave
     * the row unsent and its attempt counted — not marked delivered (the email
     * is lost for ever) and not left untouched (it is retried for ever).
     *
     * Pointed at a closed port on loopback, which fails immediately rather than
     * waiting on a timeout.
     */
    await db.query(`DELETE FROM notification WHERE body LIKE $1`, [`${MARK}%`]);
    const id = await raise({ kind: 'task_assigned', body: `${MARK} undeliverable` });

    const saved = {
      host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER, password: process.env.SMTP_PASSWORD,
    };
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    process.env.SMTP_USER = 'probe@example.invalid';
    process.env.SMTP_PASSWORD = 'not-a-real-password';

    try {
      const { sweepNotificationMail } = await import('./notification-mail');
      const result = await sweepNotificationMail();
      expect(result.sent).toBe(0);
      expect(result.failed).toBeGreaterThan(0);

      const { rows } = await db.query<{ emailed_at: string | null; email_attempts: number }>(
        `SELECT emailed_at::text, email_attempts FROM notification WHERE id = $1`, [id]);
      expect(rows[0]!.emailed_at, 'a failed send was recorded as delivered').toBeNull();
      expect(rows[0]!.email_attempts, 'a failed send was not counted').toBe(1);
    } finally {
      if (saved.host === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = saved.host;
      if (saved.port === undefined) delete process.env.SMTP_PORT; else process.env.SMTP_PORT = saved.port;
      if (saved.user === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = saved.user;
      if (saved.password === undefined) delete process.env.SMTP_PASSWORD; else process.env.SMTP_PASSWORD = saved.password;
    }
  });

  it('is actually started by the container', async () => {
    /*
     * The failure this project keeps meeting: a feature that is complete, tested,
     * deployed, and never runs. SMTP sat in .env for weeks without being
     * forwarded into the container, so every email in the system was quietly
     * absent. The sweep is one line in an entrypoint away from exactly that.
     *
     * Checked statically, because the alternative is noticing in three weeks
     * that nobody has had an email.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const entrypoint = readFileSync(join(process.cwd(), 'scripts/entrypoint.sh'), 'utf8');
    expect(entrypoint, 'the entrypoint no longer starts the mail sweep').toContain(
      'scripts/notification-mail.ts --loop',
    );
    // Backgrounded: it must not block the server from starting.
    expect(entrypoint).toMatch(/notification-mail\.ts --loop &/);
    /*
     * The condition flag, without which the daemon dies on its first line.
     *
     * `mailer.ts` starts with `import 'server-only'`, a marker that resolves to
     * a module which THROWS unless the loader asks for the `react-server` export
     * condition. Next asks; a bare node does not. The first version of this
     * crashed in the background on every container start — a log nobody reads,
     * no email ever arriving, and a green test suite.
     */
    expect(
      entrypoint,
      'the sweep is started without --conditions=react-server and will die on server-only',
    ).toContain('--conditions=react-server');
    // And not in the portal, whose role cannot read notification at all.
    expect(entrypoint).toContain('"${APP_MODE:-}" != "portal"');

    // The script the entrypoint names has to exist and take --loop.
    const daemon = readFileSync(join(process.cwd(), 'scripts/notification-mail.ts'), 'utf8');
    expect(daemon).toContain("includes('--loop')");
    expect(daemon).toContain('sweepNotificationMail');
    // It must never die on a transient failure and leave every later email unsent.
    expect(daemon).toContain('catch (error)');

    // The base URL a link in an email needs, forwarded to the container.
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    expect(compose, 'APP_URL is not forwarded — email links would be relative').toContain('APP_URL:');
  });
});

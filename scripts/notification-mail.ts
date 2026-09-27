/**
 * VIXART OS — the sweep that turns notifications into emails.
 *
 *   node_modules/.bin/tsx scripts/notification-mail.ts          # once
 *   node_modules/.bin/tsx scripts/notification-mail.ts --loop   # every 60s
 *
 * Amin asked for an email when a task is assigned and an email for a private
 * message. Those rows are written by database triggers, because a task can be
 * assigned from four screens and a notification that depends on somebody
 * remembering to call it will be missed from the fourth. A trigger has no
 * network, so something with one has to come and collect them.
 *
 * WHY A SEPARATE PROCESS, AND NOT THE APPLICATION ITSELF.
 *
 * It was written as a timer in `instrumentation.ts` first, which is the Next
 * way to run something at server start. It does not work here, and the reason is
 * worth recording: Next compiles instrumentation for EVERY runtime it targets,
 * this application has an edge one (the middleware), and webpack follows the
 * import graph whether or not a runtime check would stop the code running. `pg`
 * reaches for `fs`, edge has no `fs`, and the entire build fails pointing at a
 * dependency nobody wrote. Splitting the node-only half into its own module and
 * importing it dynamically does not help — the graph is still followed.
 *
 * A script has none of that problem, and it is also where this project already
 * puts scheduled work: the nightly jobs are a shell script in the backup
 * container, for the same reason. That container has psql and no mailer, so it
 * cannot do this one — but the application image has both, and the entrypoint
 * can start it beside the server.
 *
 * Safe to run twice, by hand, or in two containers at once: rows are claimed
 * with the statement that reads them, `FOR UPDATE SKIP LOCKED`, so two sweeps
 * take different work rather than one person receiving everything twice.
 */

import { sweepNotificationMail } from '../src/lib/notification-mail';
import { mailerConfigured } from '../src/lib/mailer';

const EVERY_MS = 60_000;

async function once(): Promise<void> {
  const { sent, failed } = await sweepNotificationMail();
  if (sent > 0 || failed > 0) {
    console.log(`[notification-mail] sent ${sent}, failed ${failed}`);
  }
}

async function main(): Promise<void> {
  if (!mailerConfigured()) {
    /*
     * Said out loud, because the silent version of this cost weeks once: SMTP
     * sat in .env on the server and was never forwarded into the container, so
     * every email feature was quietly absent and nothing anywhere said so.
     */
    console.warn(
      '[notification-mail] SMTP is not configured — task and message emails ' +
        'will NOT be sent. Notifications still appear in the inbox.',
    );
    return;
  }

  const loop = process.argv.includes('--loop');
  if (!loop) {
    await once();
    return;
  }

  console.log('[notification-mail] sweeping every 60s');

  let running = false;
  const tick = async () => {
    // A sweep slower than the interval must not overlap itself.
    if (running) return;
    running = true;
    try {
      await once();
    } catch (error) {
      // Never exit. A database that went away for a minute, or a mail host that
      // refused a connection, is a thing that comes back — and a daemon that
      // died on the first one would leave every later email unsent with nothing
      // to notice except an absence.
      console.error(
        '[notification-mail] sweep failed:',
        error instanceof Error ? error.message : error,
      );
    } finally {
      running = false;
    }
  };

  // Not immediately: a container that has just started is applying migrations
  // and serving its first requests on one core.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), EVERY_MS);
  }, 20_000);
}

main().catch((error) => {
  console.error('[notification-mail] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});

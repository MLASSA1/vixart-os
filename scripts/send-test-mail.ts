/**
 * Sends one test message, to prove the credentials and the relay.
 *
 *   npx tsx scripts/send-test-mail.ts someone@example.com
 *
 * Reads SMTP_PASSWORD from the environment or .env — never from an argument,
 * where it would land in shell history.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

for (const file of ['.env.local', '.env']) {
  const full = path.resolve(process.cwd(), file);
  if (!existsSync(full)) continue;
  for (const line of readFileSync(full, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2]!.trim().replace(/^["'](.*)["']$/, '$1');
  }
}

/**
 * `server-only` throws on import by design — that is how it stops a client
 * component reaching server code. A CLI script is not a client component, and
 * has nothing to be protected from, so the module is satisfied before the
 * mailer pulls it in. The guard stays where it belongs, in the source.
 *
 * vitest does the same thing with an alias in vitest.config.ts.
 */
function allowServerOnlyInCli(): void {
  const resolved = require.resolve('server-only');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
  } as NodeJS.Module;
}

async function main() {
  const to = process.argv[2];
  if (!to) throw new Error('Usage: tsx scripts/send-test-mail.ts <address>');

  allowServerOnlyInCli();
  const { mailerConfig, verifyMailer, sendMail } = await import('../src/lib/mailer');
  const c = mailerConfig();
  console.log(`[mail] relay    ${c.host}:${c.port}`);
  console.log(`[mail] from     ${c.from}`);
  console.log(`[mail] password ${c.password ? 'set' : 'NOT SET'}`);

  console.log('[mail] verifying credentials…');
  await verifyMailer();
  console.log('[mail] credentials accepted');

  const id = await sendMail({
    to,
    subject: 'VIXART OS — test',
    text:
      'This is a test from VIXART OS.\n\n' +
      'If you are reading it, notifications can reach you by email when you are ' +
      'not signed in.\n\nNothing else was sent.\n',
  });
  console.log(`[mail] sent to ${to} — ${id}`);
}

main().catch((e) => {
  console.error('[mail] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});

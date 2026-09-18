/**
 * The one-off welcome to the team.
 *
 * Recipients and their state come from the database, not a list typed here —
 * so nobody is missed, nobody gets a stale address, and the password sentence
 * is right for each person rather than the same guess for everyone.
 *
 * Service accounts and admins are excluded by the query.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

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

function allowServerOnlyInCli(): void {
  const resolved = require.resolve('server-only');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: {},
  } as NodeJS.Module;
}

interface Person {
  email: string;
  full_name: string;
  needs_first_password: boolean;
}

function body(p: Person): string {
  const password = p.needs_first_password
    ? 'Amin will send you your first password. The app will ask you to choose\nyour own straight away.'
    : 'Your password: the one you chose when you first signed in.';

  return `Hi ${p.full_name},

VIXART OS is the agency's own system. It replaces the scattered notes, chats
and spreadsheets with one place for the work.

  Chat      A channel for every project and every client, already set up.
            Send voice notes, drag files in, and type @ to mention someone,
            which notifies them.

  My work   The tasks assigned to you and what's due.

  Prep      Where you plan a video before it's assigned. Private while you
            write it, shared the moment you're ready.

  Projects  What we're building, and who for.
  & clients

Sign in at https://visionxart.cloud
Your email: ${p.email}
${password}

If anything looks wrong, tell Amin.

— VIXART
`;
}

async function main() {
  allowServerOnlyInCli();
  const { sendMail, verifyMailer } = await import('../src/lib/mailer');

  // Production's database is reachable only from inside its own network, so
  // the recipients can also be handed in as JSON, read out of that database by
  // whoever can reach it. Same shape either way; never a list typed by hand.
  const fromFile = process.env.RECIPIENTS_FILE;
  let rows: Person[];
  if (fromFile) {
    rows = JSON.parse(readFileSync(fromFile, 'utf8')) as Person[];
  } else {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const result = await pg.query<Person>(
      `SELECT email, full_name, must_change_password AS needs_first_password
         FROM app_user
        WHERE password_hash NOT LIKE 'NO-LOGIN%' AND role <> 'admin'
        ORDER BY full_name`,
    );
    await pg.end();
    rows = result.rows;
  }

  console.log(`[welcome] ${rows.length} recipient(s), verifying the relay first`);
  await verifyMailer();

  const copyTo = process.env.WELCOME_COPY_TO;
  const all = copyTo
    ? [...rows, { email: copyTo, full_name: 'Amin', needs_first_password: false }]
    : rows;

  for (const p of all) {
    const id = await sendMail({
      to: p.email,
      subject: 'Welcome to VIXART OS',
      text: body(p),
    });
    console.log(`  sent  ${p.email.padEnd(30)} ${id}`);
  }
  console.log('[welcome] done');
}

main().catch((e) => {
  console.error('[welcome] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});

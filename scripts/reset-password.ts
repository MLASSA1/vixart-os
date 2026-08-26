/**
 * VIXART OS — reset one account's password.
 *
 * A bcrypt hash cannot be reversed, so a forgotten password is not recoverable
 * by anyone, including whoever runs the database. It can only be replaced.
 *
 * The new password comes in through the environment, never as an argument:
 * arguments show up in `ps` and in shell history, environment variables of a
 * one-off process do not.
 *
 *   NEW_PASSWORD='…' npx tsx scripts/reset-password.ts amin@vixart.ma
 */

import { hash } from 'bcryptjs';
import { Client } from 'pg';

async function main() {
  const email = process.argv[2];
  const password = process.env.NEW_PASSWORD;
  const url = process.env.DATABASE_URL;

  if (!email) throw new Error('Usage: NEW_PASSWORD=… npx tsx scripts/reset-password.ts <email>');
  if (!url) throw new Error('DATABASE_URL missing — run with the values from .env');
  if (!password || password.length < 10) {
    throw new Error('NEW_PASSWORD missing or shorter than 10 characters');
  }

  const pg = new Client({ connectionString: url });
  await pg.connect();

  try {
    // RLS is FORCEd even for the table owner; this is the same explicit door
    // the seed and the migrations use.
    await pg.query("SET app.bootstrap = 'on'");

    // Cost 12, matching the seed: ~250 ms to compute, which is nothing here and
    // painful at scale for anyone working through a stolen table offline.
    const passwordHash = await hash(password, 12);

    // must_change_password is set on purpose. A password someone else chose,
    // and that has been typed into a chat or a terminal, is a temporary key —
    // it gets the owner through the door once and is replaced immediately. The
    // sign-in flow already enforces the flag; this just raises it.
    const { rowCount } = await pg.query(
      `UPDATE app_user
          SET password_hash = $2, must_change_password = true
        WHERE email = $1 AND password_hash <> $3`,
      [email, passwordHash, 'NO-LOGIN'],
    );

    if (rowCount === 0) {
      // Either no such person, or a service account. Service accounts are the
      // agents: they authenticate to Postgres by role, never by password, and
      // giving one a usable password would open a door that is meant to be
      // welded shut.
      throw new Error(`No password-holding account for "${email}" (unknown, or a service account)`);
    }

    console.log(`[reset] password replaced for ${email}`);
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error('[reset] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Open a client account from the command line, and send the invitation.
 *
 *   docker compose exec app node_modules/.bin/tsx scripts/open-client-account.ts <email>
 *
 * WHY THIS EXISTS, GIVEN THERE IS A BUTTON FOR IT.
 *
 * The button on a client's page is the way to do this, and it should stay the
 * way. This is for the cases the button cannot reach: opening the first
 * account on a machine nobody is signed in to, and reissuing a password for
 * somebody who is locked out while the person who could click it is asleep.
 *
 * It calls the SAME functions the action does — `generatePassword`,
 * `hashPassword`, `invitationExpiry`, `invitationMail`, `sendMail` — so the
 * password it produces, the expiry it sets and the email it writes are the
 * ones the application produces. A second implementation here would drift,
 * and it would drift in the part nobody looks at: the strength of a password
 * and the life of an invitation.
 *
 * It prints no password. The invitation goes to the mailbox and nowhere else;
 * echoing it into a terminal puts it in scrollback, in a screen recording and
 * in whatever logs the shell keeps.
 */

import { Client } from 'pg';
import {
  generatePassword,
  hashPassword,
  invitationExpiry,
  invitationMail,
} from '../src/lib/client-access';
import { sendMail, mailerConfigured } from '../src/lib/mailer';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email) {
    throw new Error(
      'Usage: tsx scripts/open-client-account.ts <contact email>\n' +
        'The contact must already exist, with that address, on a client record.',
    );
  }

  if (!mailerConfigured()) {
    throw new Error(
      'SMTP is not configured on this machine, so the invitation cannot be ' +
        'sent. Refusing to create an account whose password nobody receives.',
    );
  }

  const db = new Client({ connectionString: requireEnv('DATABASE_URL') });
  await db.connect();

  try {
    const found = await db.query<{
      contact_id: string; full_name: string; email: string;
      company_id: string; company_name: string; has_account: boolean;
    }>(
      `SELECT c.id AS contact_id, c.full_name, c.email,
              c.company_id, co.name AS company_name,
              EXISTS (SELECT 1 FROM client_account a WHERE a.contact_id = c.id) AS has_account
         FROM contact c JOIN company co ON co.id = c.company_id
        WHERE lower(c.email) = $1`,
      [email],
    );

    const row = found.rows[0];
    if (!row) {
      throw new Error(
        `No contact on record with the address ${email}. Add the contact to a ` +
          `client first — this opens an account for somebody who already exists.`,
      );
    }

    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const expiresAt = invitationExpiry();

    // Bootstrap: this runs with no signed-in person, so the policies have no
    // identity to evaluate. Scoped to this transaction and nothing else.
    await db.query('BEGIN');
    await db.query("SET LOCAL app.bootstrap = 'on'");

    if (row.has_account) {
      console.log(`[client] ${row.full_name} already has an account — reissuing`);
      await db.query(
        `UPDATE client_account
            SET password_hash = $2, must_change_password = true,
                initial_password_expires_at = $3, is_active = true, updated_at = now()
          WHERE contact_id = $1`,
        [row.contact_id, passwordHash, expiresAt.toISOString()],
      );
    } else {
      await db.query(
        `INSERT INTO client_account
           (contact_id, password_hash, must_change_password, initial_password_expires_at)
         VALUES ($1,$2,true,$3)`,
        [row.contact_id, passwordHash, expiresAt.toISOString()],
      );
    }

    // The support conversation, created with the account so the client does
    // not sign in to a page with nowhere to write.
    const staff = await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role='admin' AND is_active ORDER BY created_at LIMIT 1`,
    );
    await db.query(
      `INSERT INTO thread (kind, title, company_id, created_by_id)
       SELECT 'support', $2, $1, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM thread WHERE kind='support' AND company_id = $1)`,
      [row.company_id, `${row.company_name} — support`, staff.rows[0]?.id ?? null],
    );

    await db.query('COMMIT');
    console.log(`[client] account ready for ${row.full_name} (${row.company_name})`);

    const url = process.env.PORTAL_URL ?? 'https://client.visionxart.cloud';
    const mail = invitationMail({
      fullName: row.full_name,
      companyName: row.company_name,
      email: row.email,
      password,
      url,
    });
    await sendMail({ to: row.email, ...mail });

    // The address, never the password.
    console.log(`[client] invitation sent to ${row.email} — valid for 7 days`);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('[client] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});

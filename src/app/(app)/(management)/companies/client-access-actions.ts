'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/auth';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { sendMail, mailerConfigured } from '@/lib/mailer';
import {
  generatePassword,
  hashPassword,
  invitationExpiry,
  invitationMail,
} from '@/lib/client-access';

/** Where a client signs in. The portal's own host, never the internal one. */
function portalUrl(): string {
  return process.env.PORTAL_URL ?? 'https://client.visionxart.cloud';
}

/**
 * Opens an account for one contact, and sends them the invitation.
 *
 * The order matters. The account is written first and the email sent second,
 * because the reverse would send somebody a password for an account that a
 * failed transaction then rolled back — a person holding a credential that
 * does not work, with no way to tell them apart from a person whose email
 * simply has not arrived.
 *
 * If the send fails, the account stays and the form says so. That is
 * recoverable: the password can be reissued. The opposite is not.
 */
export async function openClientAccountAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireSession();
  if (session.user.role !== 'admin' && session.user.role !== 'moderator') {
    return { error: 'Only management can open a client account.' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  if (!contactId) return { error: 'Choose who the account is for.' };

  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const expiresAt = invitationExpiry();

  let invitation: { email: string; fullName: string; companyName: string; companyId: string };

  try {
    invitation = await withUser(async (tx) => {
      // Read the contact through this person's own policies: a moderator who
      // cannot see the client cannot open an account on it either.
      const found = await tx.execute<{
        email: string | null; full_name: string; company_id: string; company_name: string;
      }>(sql`
        SELECT c.email, c.full_name, c.company_id, co.name AS company_name
          FROM contact c JOIN company co ON co.id = c.company_id
         WHERE c.id = ${contactId}
      `);
      const row = found.rows[0];
      if (!row) throw new Error('That contact is not on record.');
      if (!row.email?.trim()) {
        throw new Error('That contact has no email address. Add one first.');
      }

      await tx.execute(sql`
        INSERT INTO client_account
          (contact_id, password_hash, must_change_password,
           initial_password_expires_at, created_by_id)
        VALUES (${contactId}, ${passwordHash}, true, ${expiresAt.toISOString()},
                ${session.user.id})
      `);

      /*
       * The support conversation, created with the account rather than on
       * first use. A client who signs in and finds nowhere to write has been
       * given a portal with a dead end in it; and creating it here means it is
       * created by a member of staff, which is what `thread.created_by_id`
       * expects — a client is not an app_user and cannot be its author.
       */
      await tx.execute(sql`
        INSERT INTO thread (kind, title, company_id, created_by_id)
        SELECT 'support', ${`${row.company_name} — support`}, ${row.company_id},
               ${session.user.id}
         WHERE NOT EXISTS (
           SELECT 1 FROM thread WHERE kind = 'support' AND company_id = ${row.company_id}
         )
      `);

      return {
        email: row.email.trim(),
        fullName: row.full_name,
        companyName: row.company_name,
        companyId: row.company_id,
      };
    });
  } catch (error) {
    return { error: describeDbError(error, {
      client_account_contact_id_key: 'That contact already has an account.',
    }) };
  }

  revalidatePath(`/companies/${invitation.companyId}`);

  if (!mailerConfigured()) {
    return {
      error:
        'The account was created, but email is not configured on this server, ' +
        'so the invitation was not sent. Configure SMTP and reissue the password.',
    };
  }

  try {
    const mail = invitationMail({ ...invitation, password, url: portalUrl() });
    await sendMail({ to: invitation.email, ...mail });
  } catch (error) {
    return {
      error:
        `The account was created but the invitation could not be sent: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Reissue the password to try again.`,
    };
  }

  return EMPTY_STATE;
}

/**
 * A new password for an account that already exists.
 *
 * The one the client was sent has expired, or never arrived, or they have
 * forgotten the one they chose. Same generation, same expiry, same email —
 * and `must_change_password` goes back on, so a reissued password is worth
 * exactly one sign-in like the first one was.
 */
export async function reissueClientPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireSession();
  if (session.user.role !== 'admin' && session.user.role !== 'moderator') {
    return { error: 'Only management can reissue a client password.' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  if (!contactId) return { error: 'Choose an account.' };

  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const expiresAt = invitationExpiry();

  let invitation: { email: string; fullName: string; companyName: string; companyId: string };

  try {
    invitation = await withUser(async (tx) => {
      const found = await tx.execute<{
        email: string | null; full_name: string; company_id: string; company_name: string;
      }>(sql`
        SELECT c.email, c.full_name, c.company_id, co.name AS company_name
          FROM client_account a
          JOIN contact c  ON c.id = a.contact_id
          JOIN company co ON co.id = c.company_id
         WHERE a.contact_id = ${contactId}
      `);
      const row = found.rows[0];
      if (!row) throw new Error('That contact has no account.');
      if (!row.email?.trim()) throw new Error('That contact has no email address.');

      await tx.execute(sql`
        UPDATE client_account
           SET password_hash = ${passwordHash},
               must_change_password = true,
               initial_password_expires_at = ${expiresAt.toISOString()},
               is_active = true
         WHERE contact_id = ${contactId}
      `);

      return {
        email: row.email.trim(),
        fullName: row.full_name,
        companyName: row.company_name,
        companyId: row.company_id,
      };
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath(`/companies/${invitation.companyId}`);

  try {
    const mail = invitationMail({ ...invitation, password, url: portalUrl() });
    await sendMail({ to: invitation.email, ...mail });
  } catch (error) {
    return {
      error: `The password was changed but the email could not be sent: ` +
        `${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  return EMPTY_STATE;
}

/**
 * Turning an account off.
 *
 * Not deleting it: the messages that client wrote in their support thread are
 * a record of what was said, and `message.author_contact_id` points at the
 * contact. Deactivating stops the sign-in and leaves the conversation intact.
 */
export async function setClientAccountActiveAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  if (session.user.role !== 'admin' && session.user.role !== 'moderator') return;

  const contactId = String(formData.get('contactId') ?? '');
  const active = String(formData.get('active') ?? '') === '1';
  const companyId = String(formData.get('companyId') ?? '');
  if (!contactId) return;

  await withUser(async (tx) => {
    await tx.execute(sql`
      UPDATE client_account SET is_active = ${active} WHERE contact_id = ${contactId}
    `);
  });

  if (companyId) revalidatePath(`/companies/${companyId}`);
}

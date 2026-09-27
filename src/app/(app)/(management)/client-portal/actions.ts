'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/auth';
import { withUser } from '@/db/session';
import {
  generatePassword,
  hashPassword,
  invitationExpiry,
  invitationMail,
} from '@/lib/client-access';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { mailerConfigured, sendMail } from '@/lib/mailer';

/** Where a client signs in. The portal's own host, never the internal one. */
function portalUrl(): string {
  return process.env.PORTAL_URL ?? 'https://client.visionxart.cloud';
}

/**
 * Management only, and said once.
 *
 * `app.is_moderator()` is the same pair in the database — admin or moderator,
 * which today is Amin and Mohamed Amine. Both layers, because this page opens
 * accounts and moves a figure a client reads, and a check that exists only in
 * a server action is a check that the next page to touch these tables will not
 * inherit.
 */
function isManagement(role: string): boolean {
  return role === 'admin' || role === 'moderator';
}

/**
 * Everything a client needs, in one submit.
 *
 * WHY THIS EXISTS WHEN THERE IS ALREADY A BUTTON.
 *
 * The button on a company's page opens an account for a contact who already
 * exists — which means the real job is four steps on three screens: create the
 * company, add a contact with an email, create a project so there is something
 * to show progress for, then find the button. Amin asked for one place, and
 * missing any of those steps produces something worse than nothing: an account
 * that signs in to an empty portal, or a project with no one who can see it.
 *
 * So this does the sequence in ONE transaction. Either the client has a
 * company, a contact, a project, an account and a support conversation, or
 * nothing was written at all.
 *
 * The invitation is sent after the transaction commits, deliberately: sending
 * inside it would email a password for an account a later failure rolled back,
 * and a person holding a credential that does not work is indistinguishable
 * from a person whose email has not arrived yet.
 */
export async function openClientSpaceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireSession();
  if (!isManagement(session.user.role)) {
    return { error: 'Only Amin or a work moderator can open a client account.' };
  }

  const companyId = String(formData.get('companyId') ?? '').trim();
  const companyName = String(formData.get('companyName') ?? '').trim();
  const fullName = String(formData.get('fullName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const projectName = String(formData.get('projectName') ?? '').trim();

  if (!companyId && !companyName) {
    return { error: 'Choose a client, or type the name of a new one.' };
  }
  if (!fullName) return { error: 'Who is the account for? Give their name.' };
  if (!email) return { error: 'An email address is required — the password is sent to it.' };
  // Shape only. Whether it receives mail is answered by the send below, and
  // nothing written here can know it in advance.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: `“${email}” does not look like an email address.` };
  }

  /*
   * The address, before anything is created.
   *
   * The database refuses a second account on one address (0068), and that is
   * the rule that matters — but the refusal would arrive after a company and a
   * contact had been written and rolled back, and what the person at the screen
   * needs is the name of the client who already has it. Asked here so the
   * answer is a sentence rather than a constraint.
   */
  const clash = await withUser(async (tx) => {
    const found = await tx.execute<{ who: string; company: string }>(sql`
      SELECT c.full_name AS who, co.name AS company
        FROM client_account a
        JOIN contact c  ON c.id = a.contact_id
        JOIN company co ON co.id = c.company_id
       WHERE lower(trim(c.email)) = ${email}
       LIMIT 1
    `);
    return found.rows[0] ?? null;
  });

  if (clash) {
    return {
      error:
        `${clash.who} at ${clash.company} already signs in with ${email}. ` +
        `One address, one account — otherwise signing in cannot tell them ` +
        `apart. Email them a new password instead, from the list below.`,
    };
  }

  // Generated before the transaction so a slow hash does not hold it open.
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const expiresAt = invitationExpiry();

  let invitation: { email: string; fullName: string; companyName: string };

  try {
    invitation = await withUser(async (tx) => {
      let company = companyId;
      let name = companyName;

      if (company) {
        const found = await tx.execute<{ name: string }>(sql`
          SELECT name FROM company WHERE id = ${company}
        `);
        const row = found.rows[0];
        // Read through this person's own policies: a moderator who cannot see
        // the client cannot open an account on it either.
        if (!row) throw new Error('That client is not on record.');
        name = row.name;
      } else {
        const made = await tx.execute<{ id: string }>(sql`
          INSERT INTO company (name, status, relationship)
          VALUES (${companyName}, 'client', 'client')
          RETURNING id
        `);
        const row = made.rows[0];
        if (!row) throw new Error('The client record could not be created.');
        company = row.id;
      }

      const contact = await tx.execute<{ id: string }>(sql`
        INSERT INTO contact (company_id, full_name, email)
        VALUES (${company}, ${fullName}, ${email})
        RETURNING id
      `);
      const contactId = contact.rows[0]?.id;
      if (!contactId) throw new Error('The contact could not be created.');

      /*
       * A project, because the portal without one is a page that says nothing.
       *
       * Amin's words were that creating an account must have the email and a
       * project "so it can see the progress", and that is the right rule: an
       * account whose first screen is empty teaches the client that the portal
       * is not worth opening again.
       *
       * But required-always would be wrong in the common case. A client already
       * on the books usually HAS projects, and demanding a new name there would
       * produce a duplicate of work that exists. So the rule is about the
       * outcome rather than the field: by the end of this transaction the
       * company must have at least one project. Name one, or it already has
       * one, or this refuses.
       */
      if (projectName) {
        await tx.execute(sql`
          INSERT INTO project (company_id, name, status)
          VALUES (${company}, ${projectName}, 'active')
        `);
      } else {
        const existing = await tx.execute<{ any: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1 FROM project WHERE company_id = ${company} AND archived_at IS NULL
          ) AS any
        `);
        if (!existing.rows[0]?.any) {
          throw new Error(
            'Give them a project to watch. Without one they sign in to a portal ' +
              'with nothing in it, which is worse than waiting a day for the account.',
          );
        }
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
       * first use — a client who signs in and finds nowhere to write has been
       * given a portal with a dead end in it. Created by a member of staff,
       * because `thread.created_by_id` expects one and a client is not an
       * app_user.
       */
      await tx.execute(sql`
        INSERT INTO thread (kind, title, company_id, created_by_id)
        SELECT 'support', ${`${name} — support`}, ${company}, ${session.user.id}
         WHERE NOT EXISTS (
           SELECT 1 FROM thread WHERE kind = 'support' AND company_id = ${company}
         )
      `);

      return { email, fullName, companyName: name };
    });
  } catch (error) {
    return {
      error: describeDbError(error, {
        client_account_contact_id_key: 'That contact already has an account.',
        contact_email_unique: 'Somebody with that email address is already on record.',
      }),
    };
  }

  revalidatePath('/client-portal');

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

  return {
    error: null,
    notice:
      `${invitation.fullName} can now sign in. The password was emailed to ` +
      `${invitation.email} and is valid for seven days if it is never used.`,
  };
}

/**
 * Moving the figure a client reads.
 *
 * An empty value CLEARS it and hands the number back to the task count. That
 * matters more than it looks: a hand-set figure that nobody clears is a number
 * that stops tracking reality the moment the team gets on with the work, so
 * going back has to be one click and not a database visit.
 *
 * The rule about who may do this is enforced by a trigger as well (0067).
 * This check is here so the answer is a sentence on the screen rather than a
 * raised exception.
 */
export async function setProjectProgressAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireSession();
  if (!isManagement(session.user.role)) {
    return { error: 'Only Amin or a work moderator can change a client’s progress.' };
  }

  const projectId = String(formData.get('projectId') ?? '').trim();
  if (!projectId) return { error: 'Which project?' };

  const raw = String(formData.get('percent') ?? '').trim();
  let percent: number | null = null;

  if (raw !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: 'Progress is a number between 0 and 100.' };
    }
    percent = Math.round(n);
  }

  try {
    await withUser(async (tx) => {
      await tx.execute(sql`
        UPDATE project SET progress_override = ${percent} WHERE id = ${projectId}
      `);
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath('/client-portal');
  // The client's own page reads the same function, so it has to be told too.
  revalidatePath('/portal');
  return EMPTY_STATE;
}

/** Turning an account off without destroying what that person said. */
export async function setClientActiveAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  if (!isManagement(session.user.role)) return;

  const contactId = String(formData.get('contactId') ?? '');
  const active = String(formData.get('active') ?? '') === '1';
  if (!contactId) return;

  await withUser(async (tx) => {
    await tx.execute(sql`
      UPDATE client_account SET is_active = ${active} WHERE contact_id = ${contactId}
    `);
  });

  revalidatePath('/client-portal');
}

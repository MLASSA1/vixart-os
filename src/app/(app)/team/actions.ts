'use server';

import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { appUser } from '@/db/schema';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_TEAM_STATE, type TeamState } from '@/lib/form-state';

const TEAM_ERRORS = {
  app_user_email_key: 'That email address already has an account.',
  app_user_email_shape: 'That does not look like an email address.',
  app_user_role_valid: 'Unknown role.',
};


const memberSchema = z.object({
  email: z.string().trim().toLowerCase().email('That does not look like an email address.'),
  fullName: z.string().trim().min(1, 'The name is required.'),
  jobTitle: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  role: z.enum(['admin', 'moderator', 'member']),
});

/**
 * Readable, typable, and not guessable: 4 groups of 4 from an alphabet with no
 * look-alike characters, so it survives being read aloud or written on paper.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/**
 * Creates an account.
 *
 * The initial password is generated here and shown to the admin exactly once —
 * it is never stored in readable form, and the new member must change it before
 * reaching anything.
 */
export async function createMemberAction(
  _previous: TeamState,
  formData: FormData,
): Promise<TeamState> {
  const parsed = memberSchema.safeParse({
    email: formData.get('email') ?? '',
    fullName: formData.get('fullName') ?? '',
    jobTitle: formData.get('jobTitle') ?? '',
    role: formData.get('role') ?? 'member',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  const password = generatePassword();
  const passwordHash = await hash(password, 12);

  try {
    await withUser(async (tx) => {
      await tx.execute(sql`
        SELECT app.create_team_member(
          ${parsed.data.email}, ${parsed.data.fullName},
          ${parsed.data.jobTitle}, ${parsed.data.role}, ${passwordHash})
      `);
    });
  } catch (error) {
    return { error: describeDbError(error, TEAM_ERRORS) };
  }

  revalidatePath('/team');
  return {
    error: null,
    createdPassword: password,
    createdFor: `${parsed.data.fullName} (${parsed.data.email})`,
  };
}

/** Changes someone's role. The database refuses self-changes and lockouts. */
export async function setRoleAction(formData: FormData): Promise<void> {
  const id = String(formData.get('userId') ?? '');
  const role = String(formData.get('role') ?? '');
  if (!id || !['admin', 'moderator', 'member'].includes(role)) return;

  await withUser(async (tx) => {
    await tx.update(appUser).set({ role }).where(eq(appUser.id, id));
  });
  revalidatePath('/team');
}

/**
 * Removing someone means deactivating them, not deleting.
 *
 * Their name stays on the timeline entries they wrote, the tasks they
 * completed and the ledger lines they recorded. Deleting the row would either
 * orphan that history or drag it out with them; deactivating stops the sign-in
 * and leaves the record of the work intact.
 */
export async function setActiveAction(formData: FormData): Promise<void> {
  const id = String(formData.get('userId') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';
  if (!id) return;

  await withUser(async (tx) => {
    await tx.update(appUser).set({ isActive: active }).where(eq(appUser.id, id));
  });
  revalidatePath('/team');
}

/** Updates the display details. A member may edit their own. */
export async function updateMemberAction(
  userId: string,
  _previous: TeamState,
  formData: FormData,
): Promise<TeamState> {
  const fullName = String(formData.get('fullName') ?? '').trim();
  const jobTitle = String(formData.get('jobTitle') ?? '').trim() || null;
  if (!fullName) return { error: 'The name is required.' };

  try {
    await withUser(async (tx) => {
      await tx.update(appUser).set({ fullName, jobTitle }).where(eq(appUser.id, userId));
    });
  } catch (error) {
    return { error: describeDbError(error, TEAM_ERRORS) };
  }
  revalidatePath('/team');
  return EMPTY_TEAM_STATE;
}

/** Issues a new password for someone who is locked out. Shown once. */
export async function resetPasswordAction(
  userId: string,
  _previous: TeamState,
  _formData: FormData,
): Promise<TeamState> {
  const password = generatePassword();
  const passwordHash = await hash(password, 12);

  try {
    const name = await withUser(async (tx) => {
      await tx.execute(sql`SELECT app.admin_reset_password(${userId}, ${passwordHash})`);
      const rows = await tx
        .select({ fullName: appUser.fullName, email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, userId))
        .limit(1);
      const row = rows[0];
      return row ? `${row.fullName} (${row.email})` : 'that account';
    });

    revalidatePath('/team');
    return { error: null, createdPassword: password, createdFor: name };
  } catch (error) {
    return { error: describeDbError(error, TEAM_ERRORS) };
  }
}

/**
 * Permanent deletion. Only offered for an account that has left no trace —
 * a mistyped address created minutes ago. Anything with history is deactivated
 * instead, and the screen says so.
 */
export async function deleteMemberAction(formData: FormData): Promise<void> {
  const id = String(formData.get('userId') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '').trim();
  const expected = String(formData.get('expected') ?? '').trim();
  if (!id || expected === '' || confirmation !== expected) return;

  await withUser(async (tx) => {
    await tx.delete(appUser).where(eq(appUser.id, id));
  });
  revalidatePath('/team');
}

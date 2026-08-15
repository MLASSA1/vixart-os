'use server';

import { hash } from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { signOut } from '@/auth';
import { withUser } from '@/db/session';

export interface PasswordState {
  error: string | null;
}

/**
 * Changes the signed-in user's own password.
 *
 * The write goes through `app.set_own_password`, which only ever touches the
 * row of the current session: even a bug in this file cannot rewrite a
 * colleague's password.
 *
 * On success the session is destroyed and the user signs in again — rotating
 * the session after a credential change, and avoiding a stale
 * "must change password" flag in the JWT.
 */
export async function changePasswordAction(
  _previous: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const password = String(formData.get('password') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '');

  if (password.length < 12) {
    return { error: 'The password must be at least 12 characters long.' };
  }
  if (password !== confirmation) {
    return { error: 'The two entries do not match.' };
  }

  // bcrypt cost 12: ~250 ms per hash, painful to brute-force offline,
  // unnoticeable here.
  const passwordHash = await hash(password, 12);

  await withUser(async (tx) => {
    await tx.execute(sql`SELECT app.set_own_password(${passwordHash})`);
  });

  await signOut({ redirectTo: '/sign-in?changed=1' });
  return { error: null };
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/sign-in' });
}

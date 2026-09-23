'use server';

import { sql } from 'drizzle-orm';
import { hash } from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { requireClientSession, signOut } from '@/auth';
import { withClient } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/** The same floor the team's own accounts use. */
const MIN_LENGTH = 12;

/**
 * A client chooses their own password.
 *
 * The hash is computed here and handed to `app.set_own_client_password`, which
 * writes only the session's own row. The plaintext never reaches the database
 * and is never logged.
 */
export async function setClientPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  /*
   * Caught rather than allowed to propagate. A session that expired between
   * loading the page and pressing the button is ordinary — twelve hours is not
   * long — and it should read as "sign in again", not as the application
   * breaking. The thrown version is still correct for anything that is not a
   * form.
   */
  let session;
  try {
    session = await requireClientSession();
  } catch {
    return { error: 'Your session has expired. Sign in again and retry.' };
  }

  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (password.length < MIN_LENGTH) {
    return { error: `Use at least ${MIN_LENGTH} characters.` };
  }
  if (password !== confirm) {
    return { error: 'The two passwords are not the same.' };
  }

  try {
    const digest = await hash(password, 12);
    await withClient(session.user.id, async (tx) => {
      await tx.execute(sql`SELECT app.set_own_client_password(${digest})`);
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  /*
   * Signed out, deliberately.
   *
   * The session is a signed JWT and it still says `mustChangePassword: true`
   * — the database row has changed, the token has not. Leaving them on this
   * page means every other page redirects back to it and the client is stuck
   * in a loop being told to do the thing they just did.
   *
   * Refreshing the token would also work and is what the staff application
   * does. Signing out is better here: it ends the session that was opened
   * with a password we generated and emailed, and it makes them prove the new
   * one works while they still remember typing it.
   */
  revalidatePath('/portal/account');
  await signOut({ redirectTo: '/portal/sign-in?changed=1' });
  return EMPTY_STATE;
}

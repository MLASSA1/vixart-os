'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/auth';

export interface SignInState {
  error: string | null;
}

/**
 * The client portal's sign-in.
 *
 * Goes to the `client` provider, which exists only when this container runs
 * with APP_MODE=portal — so on the internal application this action has no
 * provider to reach and fails closed.
 *
 * One message for every refusal, as on the staff door: unknown address, wrong
 * password, deactivated account, expired invitation. A portal on the public
 * internet is the more exposed of the two, and "that address has an account
 * but the password is wrong" tells a stranger which of VIXART's clients are
 * worth pursuing.
 */
export async function clientSignInAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email address and password.' };
  }

  try {
    await signIn('client', { email, password, redirectTo: '/portal' });
    return { error: null };
  } catch (error) {
    // `signIn` signals a successful redirect by throwing: let that through.
    if (error instanceof AuthError) {
      return {
        error:
          'We could not sign you in. If your invitation is more than a week old ' +
          'it has expired — ask us for a new one.',
      };
    }
    throw error;
  }
}

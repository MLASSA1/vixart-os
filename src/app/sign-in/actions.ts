'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/auth';

export interface SignInState {
  error: string | null;
}

/**
 * Credentials sign-in.
 *
 * The message is deliberately identical whether the address is unknown or the
 * password is wrong: nothing here should let someone enumerate the five
 * accounts of the agency.
 */
export async function signInAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email address and password.' };
  }

  try {
    await signIn('credentials', { email, password, redirectTo: '/clients' });
    return { error: null };
  } catch (error) {
    // `signIn` signals a successful redirect by throwing: let that through.
    if (error instanceof AuthError) {
      return { error: 'Incorrect email address or password.' };
    }
    throw error;
  }
}

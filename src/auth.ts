/**
 * VIXART OS — authentication.
 *
 * Five accounts, no public sign-up, no external provider.
 * Sessions are signed JWTs: no session table to back up, and restoring the
 * database does not sign anyone out.
 *
 * Password verification goes through `app.lookup_login`, a narrow SECURITY
 * DEFINER function: at sign-in time no session exists yet and RLS forbids the
 * application role from reading `app_user`. No owner connection is ever opened
 * from an HTTP route.
 */

import { compare } from 'bcryptjs';
import { sql } from 'drizzle-orm';
import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { getDb } from '@/db';

export type UserRole = 'admin' | 'member';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      jobTitle: string | null;
      mustChangePassword: boolean;
    } & DefaultSession['user'];
  }

  interface User {
    id?: string;
    role: UserRole;
    jobTitle: string | null;
    mustChangePassword: boolean;
  }
}

/**
 * Fields this application carries on the JWT. Declared locally rather than by
 * augmenting `next-auth/jwt`: the beta does not export that module path
 * consistently, and a cast at the two call sites is clearer than a broken
 * global augmentation.
 */
interface VixartToken {
  id: string;
  role: UserRole;
  jobTitle: string | null;
  mustChangePassword: boolean;
}

/**
 * Decoy hash used when the address is unknown: the bcrypt comparison runs in
 * every case, so response time does not reveal whether an account exists.
 */
const DECOY_HASH = '$2b$12$0000000000000000000000000000000000000000000000000000';

interface LoginRow {
  [column: string]: unknown;
  id: string;
  email: string;
  full_name: string;
  job_title: string | null;
  role: UserRole;
  password_hash: string;
  must_change_password: boolean;
  is_active: boolean;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: {
    strategy: 'jwt',
    // One working day. After that, sign in again.
    maxAge: 12 * 60 * 60,
  },
  pages: {
    signIn: '/sign-in',
    error: '/sign-in',
  },
  providers: [
    Credentials({
      name: 'VIXART credentials',
      credentials: {
        email: { label: 'Email address', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === 'string' ? credentials.email : '';
        const password =
          typeof credentials?.password === 'string' ? credentials.password : '';

        if (!email || !password) return null;

        const result = await getDb().execute<LoginRow>(
          sql`SELECT * FROM app.lookup_login(${email})`,
        );
        const row = result.rows[0];

        // Comparison runs even with no account: constant response time.
        const hash = row?.password_hash ?? DECOY_HASH;
        const matches = await compare(password, hash);

        if (!row || !matches || !row.is_active) return null;

        return {
          id: row.id,
          email: row.email,
          name: row.full_name,
          role: row.role,
          jobTitle: row.job_title,
          mustChangePassword: row.must_change_password,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user, trigger, session }) {
      const claims = token as unknown as VixartToken;
      if (user) {
        claims.id = user.id ?? '';
        claims.role = user.role;
        claims.jobTitle = user.jobTitle;
        claims.mustChangePassword = user.mustChangePassword;
      }
      // After a successful password change the flag clears without needing
      // to sign in again.
      if (trigger === 'update' && session && typeof session === 'object') {
        const update = session as { mustChangePassword?: boolean };
        if (typeof update.mustChangePassword === 'boolean') {
          claims.mustChangePassword = update.mustChangePassword;
        }
      }
      return token;
    },
    session({ session, token }) {
      const claims = token as unknown as VixartToken;
      session.user.id = claims.id;
      session.user.role = claims.role;
      session.user.jobTitle = claims.jobTitle;
      session.user.mustChangePassword = claims.mustChangePassword;
      return session;
    },
  },
});

/** Guaranteed non-null session — throws when the caller is not signed in. */
export async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Sign-in required');
  }
  return session;
}

/** Guaranteed admin session — throws when the caller is not an administrator. */
export async function requireAdminSession() {
  const session = await requireSession();
  if (session.user.role !== 'admin') {
    throw new Error('Management only');
  }
  return session;
}

/**
 * VIXART OS — authentication.
 *
 * Team accounts only, no public sign-up, no external provider.
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
import { getClientDb, getDb } from '@/db';

export type UserRole = 'admin' | 'moderator' | 'member';

/**
 * Which half of the system this process serves.
 *
 * `portal` registers ONLY the client provider and `internal` only the staff
 * one, so a client cannot attempt a staff sign-in and a member of staff cannot
 * sign in through the portal — there is no provider there to answer them. Set
 * per container; the portal's compose service sets APP_MODE=portal.
 *
 * The two deployments also hold DIFFERENT auth secrets. Sharing one would mean
 * a session token minted by the portal was a validly signed token for the
 * internal application, and the only thing standing between it and the rest of
 * the business would be a `kind` check somebody remembered to write.
 */
export const APP_MODE: 'internal' | 'portal' =
  process.env.APP_MODE === 'portal' ? 'portal' : 'internal';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      jobTitle: string | null;
      mustChangePassword: boolean;
      /** 'staff' for the internal application, 'client' for the portal. */
      kind: 'staff' | 'client';
      /** Client sessions only: the company they belong to, and its name. */
      companyId: string | null;
      companyName: string | null;
    } & DefaultSession['user'];
  }

  interface User {
    id?: string;
    role: UserRole;
    jobTitle: string | null;
    mustChangePassword: boolean;
    kind: 'staff' | 'client';
    companyId: string | null;
    companyName: string | null;
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
  kind: 'staff' | 'client';
  companyId: string | null;
  companyName: string | null;
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


/**
 * The client portal's sign-in.
 *
 * Structurally the same as the staff one and pointed at a different door:
 * `app.lookup_client_login` reads `client_account` joined to `contact`, and
 * the connection it runs on is the client role's — which cannot read app_user
 * at all, so there is no path from here into a staff account.
 *
 * The same constant-time shape: the bcrypt comparison runs whether or not the
 * address is known, so response time does not say which client is ours.
 */
interface ClientLoginRow {
  [column: string]: unknown;
  contact_id: string;
  company_id: string;
  full_name: string;
  email: string;
  company_name: string;
  password_hash: string;
  must_change_password: boolean;
  is_active: boolean;
  initial_password_expires_at: string | null;
}

const clientProvider = Credentials({
  id: 'client',
  name: 'VIXART client',
  credentials: {
    email: { label: 'Email address', type: 'email' },
    password: { label: 'Password', type: 'password' },
  },
  async authorize(credentials, request) {
    const email = typeof credentials?.email === 'string' ? credentials.email : '';
    const password = typeof credentials?.password === 'string' ? credentials.password : '';
    if (!email || !password) return null;

    const forwarded = request?.headers?.get('x-forwarded-for') ?? '';
    const ip = forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? null;

    const db = getClientDb();

    // The same throttle the staff door uses, counted in the same table. A
    // client portal on the public internet is the more exposed of the two.
    const gate = await db.execute<{ retry_after: number }>(
      sql`SELECT app.login_retry_after(${email}, ${ip}) AS retry_after`,
    );
    if (Number(gate.rows[0]?.retry_after ?? 0) > 0) {
      await db.execute(sql`SELECT app.record_login_attempt(${email}, ${ip}, false)`);
      return null;
    }

    const result = await db.execute<ClientLoginRow>(
      sql`SELECT * FROM app.lookup_client_login(${email})`,
    );
    const row = result.rows[0];

    const hash = row?.password_hash ?? DECOY_HASH;
    const matches = await compare(password, hash);

    /*
     * The expiry on a first password.
     *
     * Amin chose to have the first password generated and emailed, with the
     * objection recorded. This is the part that limits it: an invitation that
     * is never used stops working, so a forgotten message in an inbox is not a
     * permanent key to the account. It applies only while the password is
     * still the generated one — `must_change_password` — and the column is
     * cleared the moment they choose their own.
     */
    const expired = Boolean(
      row?.must_change_password &&
        row.initial_password_expires_at &&
        new Date(row.initial_password_expires_at).getTime() < Date.now(),
    );

    const ok = Boolean(row && matches && row.is_active && !expired);
    await db.execute(sql`SELECT app.record_login_attempt(${email}, ${ip}, ${ok})`);
    if (!row || !ok) return null;

    return {
      id: row.contact_id,
      email: row.email,
      name: row.full_name,
      // A client has no standing in the internal role system. 'member' is the
      // narrowest value the type allows and is never consulted for a client:
      // every policy that matters keys off `kind` and the contact id.
      role: 'member' as const,
      jobTitle: null,
      mustChangePassword: row.must_change_password,
      kind: 'client' as const,
      companyId: row.company_id,
      companyName: row.company_name,
    };
  },
});

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
  /*
   * ONE provider, chosen by which application this container is.
   *
   * Not two providers with a check inside them: a provider that exists can be
   * reached, and `/api/auth/callback/credentials` is a URL anybody may post
   * to. In the portal the staff door is not shut, it is absent.
   */
  providers: APP_MODE === 'portal' ? [clientProvider] : [
    Credentials({
      name: 'VIXART credentials',
      credentials: {
        email: { label: 'Email address', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        const email = typeof credentials?.email === 'string' ? credentials.email : '';
        const password =
          typeof credentials?.password === 'string' ? credentials.password : '';

        if (!email || !password) return null;

        // Who is asking. nginx sets X-Forwarded-For; the last hop it appends is
        // the one it actually saw, and the only entry a client cannot forge by
        // sending a header of its own.
        const forwarded = request?.headers?.get('x-forwarded-for') ?? '';
        const ip = forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? null;

        const db = getDb();

        // Before the password is even looked at: has this account, or this
        // address, been guessed at too much lately?
        const gate = await db.execute<{ retry_after: number }>(
          sql`SELECT app.login_retry_after(${email}, ${ip}) AS retry_after`,
        );
        const retryAfter = Number(gate.rows[0]?.retry_after ?? 0);
        if (retryAfter > 0) {
          // Deliberately the same refusal a wrong password gets. Telling an
          // attacker they have hit a limit tells them the limit exists, how
          // fast it trips, and that the address they are trying is worth
          // trying — none of which they are owed.
          await db.execute(
            sql`SELECT app.record_login_attempt(${email}, ${ip}, false)`,
          );
          return null;
        }

        const result = await db.execute<LoginRow>(
          sql`SELECT * FROM app.lookup_login(${email})`,
        );
        const row = result.rows[0];

        // Comparison runs even with no account: constant response time.
        const hash = row?.password_hash ?? DECOY_HASH;
        const matches = await compare(password, hash);

        const ok = Boolean(row && matches && row.is_active);
        await db.execute(sql`SELECT app.record_login_attempt(${email}, ${ip}, ${ok})`);

        if (!row || !matches || !row.is_active) return null;

        return {
          id: row.id,
          email: row.email,
          name: row.full_name,
          role: row.role,
          jobTitle: row.job_title,
          mustChangePassword: row.must_change_password,
          kind: 'staff' as const,
          companyId: null,
          companyName: null,
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
        claims.kind = user.kind;
        claims.companyId = user.companyId;
        claims.companyName = user.companyName;
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
      // Defaults to 'staff' so a token minted before this existed is not
      // silently treated as a client — the safer of the two mistakes.
      session.user.kind = claims.kind === 'client' ? 'client' : 'staff';
      session.user.companyId = claims.companyId ?? null;
      session.user.companyName = claims.companyName ?? null;
      return session;
    },
  },
});

/**
 * Guaranteed non-null STAFF session — throws when the caller is not signed in,
 * and throws just as hard when the caller is a client.
 *
 * The second check should be unreachable: the two deployments hold different
 * auth secrets, so a portal token does not verify here at all. It is written
 * anyway, because "should be unreachable" is a description of the code today
 * and this is the function every internal page hangs off. If those secrets are
 * ever made the same by someone tidying an env file, this is what stops a
 * client session reading the business.
 */
export async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Sign-in required');
  }
  if (session.user.kind === 'client') {
    throw new Error('Sign-in required');
  }
  return session;
}

/** The mirror of it: a client session, and never a member of staff. */
export async function requireClientSession() {
  const session = await auth();
  if (!session?.user?.id || session.user.kind !== 'client') {
    throw new Error('Sign-in required');
  }
  if (!session.user.companyId) {
    // A client token with no company is malformed. Refuse rather than let a
    // page decide what to do with it.
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

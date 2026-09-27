/**
 * VIXART OS — running a query in the signed-in user's context.
 *
 * This is the piece that wires authentication to Row Level Security.
 *
 * The pool recycles connections between HTTP requests: setting the context with
 * a plain `SET` would leak it into the next request, served to a different
 * user. Everything therefore goes through a transaction and `set_config(…,
 * true)` — the equivalent of `SET LOCAL` — so the context dies with the
 * transaction, including on error.
 *
 * Project rule: no business read or write happens outside `withUser`.
 */

import { sql } from 'drizzle-orm';
import { requireSession } from '@/auth';
import { getClientDb, getDb, type Database } from './index';

export interface UserContext {
  id: string;
  role: 'admin' | 'moderator' | 'member';
  name: string;
}

/** The transaction handle handed to every `withUser` body. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Opens a transaction, injects the session identity into it, runs the work.
 *
 * The role handed to PostgreSQL comes from the signed JWT, never from a request
 * parameter: a member cannot become an admin by editing a URL.
 */
export async function withUser<T>(
  work: (tx: Tx, user: UserContext) => Promise<T>,
): Promise<T> {
  const session = await requireSession();
  const user: UserContext = {
    id: session.user.id,
    role: session.user.role,
    name: session.user.name ?? session.user.email ?? 'Unknown',
  };

  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${user.id}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_role', ${user.role}, true)`);

    /*
     * THE ACCOUNT, AS IT STANDS NOW — not as it stood when the token was minted.
     *
     * Identity and role came from a signed JWT with a twelve-hour life, and every
     * policy below trusts what this transaction was told. So `is_active` and
     * `role` were read once, at sign-in, and never again: turning somebody off
     * changed a row that nothing downstream consulted, and a demoted
     * administrator kept administrator access until their token expired. Found in
     * a source audit.
     *
     * One query, here, because this is the single door every staff read and write
     * in the application goes through. Putting the check in pages would mean
     * putting it in all of them, and in the ones written next year.
     *
     * The GUCs are set BEFORE this runs because `app_user_select` is written in
     * terms of them — and it only ever returns this person's own row, so the
     * momentarily-stale role cannot read anything it should not.
     */
    const current = await tx.execute<{ role: string; is_active: boolean }>(sql`
      SELECT role, is_active FROM app_user WHERE id = ${user.id}
    `);
    const account = current.rows[0];

    if (!account || !account.is_active) {
      // Same message as an absent session. Whether an account exists and is
      // switched off is not a distinction worth drawing for whoever is asking.
      throw new Error('Sign-in required');
    }

    if (account.role !== user.role) {
      // The database is right and the token is stale. Re-set rather than throw:
      // a promotion should not sign somebody out, and a demotion should take
      // effect on this request rather than the next one.
      user.role = account.role as UserContext['role'];
      await tx.execute(sql`SELECT set_config('app.user_role', ${account.role}, true)`);
    }

    return work(tx, user);
  });
}

/**
 * Variant for management-only screens. The check is doubled: here for a
 * readable error, and in the RLS policies for the actual guarantee.
 */
export async function withAdmin<T>(
  work: (tx: Tx, user: UserContext) => Promise<T>,
): Promise<T> {
  return withUser(async (tx, user) => {
    if (user.role !== 'admin') {
      throw new Error('Management only');
    }
    return work(tx, user);
  });
}

/** Admin or the work moderator — assigning tasks, shaping projects. */
export async function withModerator<T>(
  work: (tx: Tx, user: UserContext) => Promise<T>,
): Promise<T> {
  return withUser(async (tx, user) => {
    if (user.role !== 'admin' && user.role !== 'moderator') {
      throw new Error('Moderators only');
    }
    return work(tx, user);
  });
}

// ---------------------------------------------------------------------------
// The client portal
// ---------------------------------------------------------------------------

/** Who the portal is serving. A contact, never a member of staff. */
export interface ClientContext {
  contactId: string;
  companyId: string;
  name: string;
  companyName: string;
}

/**
 * Runs work as the signed-in CLIENT, on the client role's connection.
 *
 * Deliberately a separate function from `withUser` rather than a flag on it.
 * A flag is something you can forget to pass, and forgetting it here would run
 * a portal query on the application role — which can read every client in the
 * system. Two doors, each leading somewhere different, is harder to walk
 * through by accident than one door with a switch on it.
 *
 * Only `app.client_contact_id` is set. The company is NOT set: policies derive
 * it with `app.current_client_company()`, so the portal cannot name a company
 * it does not belong to even if it tried.
 */
/**
 * Whether this client's account is still live, without throwing.
 *
 * The same question `withClient` asks, asked by a PAGE that wants to redirect
 * rather than raise. Turning an account off used to leave the person working for
 * up to twelve hours; closing that produced a 500 on every portal page, which is
 * the right access decision delivered as "something went wrong".
 *
 * Deliberately not a second copy of the rule: it calls the same
 * `app.current_client_company()` that 0073 tightened and that every client policy
 * is written in terms of, so there is one definition of "live" and this only
 * changes how the answer is delivered.
 */
export async function clientAccountIsLive(contactId: string): Promise<boolean> {
  if (!contactId) return false;
  try {
    return await getClientDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.client_contact_id', ${contactId}, true)`);
      const r = await tx.execute<{ ok: boolean }>(sql`
        SELECT app.current_client_company() IS NOT NULL AS ok
      `);
      return Boolean(r.rows[0]?.ok);
    });
  } catch {
    // A database that cannot answer is not a licence to let somebody in.
    return false;
  }
}

export async function withClient<T>(
  contactId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!contactId) throw new Error('Sign-in required');

  return getClientDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.client_contact_id', ${contactId}, true)`);

    /*
     * The client half of the same problem, and this is the readable error rather
     * than the guarantee.
     *
     * The guarantee is in `app.current_client_company()` (0073), which every
     * client policy is written in terms of and which now refuses a deactivated
     * account or an archived company — so the data is closed off whatever this
     * function does. What that alone would produce is a portal that loads and is
     * empty: no projects, no conversation, no explanation. Throwing here sends
     * them to the sign-in page instead, which is the truth about what happened.
     */
    const still = await tx.execute<{ ok: boolean }>(sql`
      SELECT app.current_client_company() IS NOT NULL AS ok
    `);
    if (!still.rows[0]?.ok) throw new Error('Sign-in required');

    return work(tx);
  });
}

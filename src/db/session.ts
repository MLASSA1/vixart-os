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
export async function withClient<T>(
  contactId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!contactId) throw new Error('Sign-in required');

  return getClientDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.client_contact_id', ${contactId}, true)`);
    return work(tx);
  });
}

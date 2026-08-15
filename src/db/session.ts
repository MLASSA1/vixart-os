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
import { getDb, type Database } from './index';

export interface UserContext {
  id: string;
  role: 'admin' | 'moderator' | 'member';
  name: string;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

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

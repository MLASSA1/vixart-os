import 'server-only';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from '@/db/schema';

/**
 * VIXART OS — the agent's database connection.
 *
 * A THIRD pool, on a third role. Not the owner, not the application role.
 * `vixart_agent` cannot issue an invoice number, edit a fiscal rate, or update
 * or delete anything at all — see drizzle/0026 and the integration test beside
 * it. That is what makes it safe to point a language model at.
 *
 * The session role is set to 'agent', which every human RLS policy fails: the
 * agent is not "authenticated", it is its own thing, and each table it can read
 * has an explicit policy saying so.
 */

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const cache = globalThis as unknown as { __vixartAgentDb?: Database };

function agentDb(): Database {
  if (!cache.__vixartAgentDb) {
    const url = process.env.AGENT_DATABASE_URL;
    if (!url) {
      throw new Error(
        'AGENT_DATABASE_URL is not set. The finance agent needs its own restricted ' +
          'role — see .env.example. It deliberately cannot reuse the application connection.',
      );
    }
    cache.__vixartAgentDb = drizzle(
      new Pool({
        connectionString: url,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        options: '-c timezone=Africa/Casablanca',
      }),
      { schema, casing: 'snake_case' },
    );
  }
  return cache.__vixartAgentDb;
}

/**
 * Runs a tool query as the agent.
 *
 * Transaction-scoped context, same as `withUser`: the pool recycles
 * connections, and a plain SET would leak the role into whatever ran next.
 */
export async function asAgent<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return agentDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_role', 'agent', true)`);
    return work(tx);
  });
}

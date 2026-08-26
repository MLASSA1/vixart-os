import 'server-only';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from '@/db/schema';

/**
 * VIXART OS — the work agent's connection.
 *
 * A fourth pool on a fourth role. `vixart_agent_work` reads the work tables and
 * may change exactly three columns on a task: who it is for, when it is due,
 * how urgent. It has no grant at all on document, finance_entry, service_price
 * or fiscal_rate — it cannot learn what anything costs, so it cannot let a
 * price influence who gets the work.
 *
 * It also cannot mark anything done. See drizzle/0028–0031.
 */

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const cache = globalThis as unknown as { __vixartWorkAgentDb?: Database };

function workDb(): Database {
  if (!cache.__vixartWorkAgentDb) {
    const url = process.env.WORK_AGENT_DATABASE_URL;
    if (!url) {
      throw new Error(
        'WORK_AGENT_DATABASE_URL is not set. The work agent needs its own restricted ' +
          'role — see .env.example. It deliberately cannot reuse another connection.',
      );
    }
    cache.__vixartWorkAgentDb = drizzle(
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
  return cache.__vixartWorkAgentDb;
}

export async function asWorkAgent<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return workDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_role', 'work_agent', true)`);
    // Named in the audit log as itself, beside the humans.
    await tx.execute(
      sql`SELECT set_config('app.user_id', app.work_agent_user_id()::text, true)`,
    );
    return work(tx);
  });
}

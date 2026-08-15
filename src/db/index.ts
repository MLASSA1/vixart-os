/**
 * VIXART OS — database connections.
 *
 * Two separate pools, two separate PostgreSQL roles:
 *
 *   `db`        → application role (APP_DATABASE_URL), NOBYPASSRLS.
 *                 Used by every query originating from an HTTP request.
 *                 Row level security applies to it.
 *
 *   getOwnerDb  → owner role (DATABASE_URL). Migrations, seeding and start-up
 *                 diagnostics. Never from a business route.
 *
 * Both pools are created lazily: `next build` imports this module to analyse
 * routes at a point where no database is reachable.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema';

// ---------------------------------------------------------------------------
// pg type parsers — applied once, before any connection.
// ---------------------------------------------------------------------------

// OID 20 = int8/BIGINT. By default `pg` returns a string. We want a bigint:
// an amount in centimes must never pass through a Number.
types.setTypeParser(20, (value: string) => BigInt(value));

// OID 1082 = date. Keep the ISO `YYYY-MM-DD` string: no timezone drift on due
// dates or effective dates.
types.setTypeParser(1082, (value: string) => value);

// OID 1700 = numeric. Not used in this schema; if it ever appears it stays a
// string rather than being silently converted to a float.
types.setTypeParser(1700, (value: string) => value);

// ---------------------------------------------------------------------------

export type Database = NodePgDatabase<typeof schema>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}. See .env.example.`);
  }
  return value;
}

function createPool(url: string, max: number): Pool {
  return new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Enforced by the container; repeated here for runs outside Docker.
    options: '-c timezone=Africa/Casablanca',
  });
}

// In development Next.js hot-reloads modules: without this global cache we
// would open one pool per reload until PostgreSQL ran out of connections.
const cache = globalThis as unknown as {
  __vixartDbApp?: Database;
  __vixartDbOwner?: Database;
};

/** Application connection — subject to RLS. Created on first use. */
export function getDb(): Database {
  if (!cache.__vixartDbApp) {
    cache.__vixartDbApp = drizzle(createPool(requireEnv('APP_DATABASE_URL'), 10), {
      schema,
      casing: 'snake_case',
    });
  }
  return cache.__vixartDbApp;
}

/**
 * Owner connection — bypasses the application pool and its policies.
 * Reserved for migrations, seeding and start-up diagnostics.
 */
export function getOwnerDb(): Database {
  if (!cache.__vixartDbOwner) {
    cache.__vixartDbOwner = drizzle(createPool(requireEnv('DATABASE_URL'), 2), {
      schema,
      casing: 'snake_case',
    });
  }
  return cache.__vixartDbOwner;
}

/**
 * Ergonomic alias for `getDb()`. The Proxy defers pool creation to first
 * property access: importing `db` connects nothing.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, property, receiver);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

export { schema };

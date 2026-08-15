/**
 * VIXART OS — application role and privileges (idempotent).
 *
 * Runs at every start of the `app` container, before the server.
 *
 * Why this is not a migration: PostgreSQL roles live at cluster level, not
 * database level; `pg_dump` does not restore them, and GRANTs are stripped by
 * `--no-privileges`. This script therefore restores the expected state after
 * any restore, without ever touching the data.
 *
 * The role created here is deliberately weak:
 *   - NOSUPERUSER, NOBYPASSRLS → row level security genuinely applies
 *   - no DDL rights            → it can neither create nor drop a table
 */

import { Client } from 'pg';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function main() {
  const ownerUrl = requireEnv('DATABASE_URL');
  const appUser = requireEnv('APP_DB_USER');
  const appPassword = requireEnv('APP_DB_PASSWORD');

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();

  try {
    // CREATE ROLE / ALTER ROLE take no bound parameters: go through a DO block,
    // where `format()` with %I / %L escapes correctly.
    await client.query(
      `DO $$
       DECLARE
         r text := ${literal(appUser)};
         p text := ${literal(appPassword)};
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
           EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
         END IF;
         EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', r, p);
       END
       $$;`,
    );

    await client.query(
      `DO $$
       DECLARE r text := ${literal(appUser)};
       BEGIN
         EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
         EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
         EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
         EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', r);

         EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
         EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
         EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', r);
         EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO %I', r);

         -- Tables created by future migrations inherit automatically.
         EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', r);
         EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r);
         EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', r);
       END
       $$;`,
    );

    // The migration journal stays out of the application's reach.
    await client.query(
      `DO $$
       DECLARE r text := ${literal(appUser)};
       BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle') THEN
           EXECUTE format('REVOKE ALL ON SCHEMA drizzle FROM %I', r);
         END IF;
       END
       $$;`,
    );

    console.log(`[grants] role "${appUser}" synchronised (NOBYPASSRLS, no DDL)`);
  } finally {
    await client.end();
  }
}

/** Escaped SQL literal — used only for role names. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

main().catch((error) => {
  console.error('[grants] FAILED:', error);
  process.exit(1);
});

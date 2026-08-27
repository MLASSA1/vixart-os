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


    // ---------------------------------------------------------------------
    // The agent roles, removed.
    //
    // Two logins used to exist here for the finance and work agents. The
    // agents are gone, and a role that can still read the books is not made
    // safe by the absence of code that uses it — anyone holding the password
    // can connect directly. So this drops them rather than merely not creating
    // them, and it runs on every start, so a database restored from a backup
    // taken before the removal is cleaned up too.
    //
    // REASSIGN is deliberately absent: these roles never owned an object, and
    // silently reassigning ownership would hide a surprise rather than raise
    // it. If a DROP ever fails because something depends on the role, that is
    // worth stopping for.
    // ---------------------------------------------------------------------
    for (const legacy of ['AGENT_DB_USER', 'WORK_AGENT_DB_USER']) {
      const name = process.env[legacy];
      if (!name) continue;
      await client.query(
        `DO $$
         DECLARE r text := ${literal(name)};
         BEGIN
           IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
             -- Schema app as well as public: app.team_directory is a view, and a
             -- privilege on it is enough to block the DROP below. The first
             -- attempt at this failed on exactly that.
             EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public, app FROM %I', r);
             EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);
             EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
             EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
             EXECUTE format('REVOKE ALL ON SCHEMA app, public FROM %I', r);
             EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), r);
             EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
             EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
             EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
             EXECUTE format('DROP ROLE %I', r);
           END IF;
         END
         $$;`,
      );
      console.log(`[grants] agent role "${name}" revoked and dropped`);
    }

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

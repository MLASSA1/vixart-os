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
    // The agent role.
    //
    // Deliberately weaker than the application role. It gets SELECT on the
    // business tables it reports on, INSERT on exactly three, and no UPDATE or
    // DELETE anywhere at all. The RLS policies in drizzle/0026 narrow those
    // INSERTs further — a document only as a draft, a ledger line only under
    // its own service account.
    //
    // Grants are the wall. The policies decide which rows; the grants decide
    // whether the verb is even available. Both have to allow it.
    // ---------------------------------------------------------------------
    const agentUser = process.env.AGENT_DB_USER;
    const agentPassword = process.env.AGENT_DB_PASSWORD;

    if (agentUser && agentPassword) {
      await client.query(
        `DO $$
         DECLARE r text := ${literal(agentUser)}; p text := ${literal(agentPassword)};
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
         DECLARE
           r text := ${literal(agentUser)};
           readable text[] := ARRAY[
             'company','contact','deal','deal_line','project','task','effort_log',
             'service','service_price','document','document_line','finance_entry',
             'recurring_entry','declaration','fiscal_rate','equipment'];
           t text;
         BEGIN
           EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
           EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
           EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', r);
           EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);

           -- Start from nothing, every time. If a table is dropped from the
           -- list above, this run takes the grant away with it.
           EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
           EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);

           FOREACH t IN ARRAY readable LOOP
             EXECUTE format('GRANT SELECT ON TABLE %I TO %I', t, r);
           END LOOP;

           -- The only three writes it can perform at all.
           EXECUTE format('GRANT INSERT ON TABLE document TO %I', r);
           EXECUTE format('GRANT INSERT ON TABLE document_line TO %I', r);
           EXECUTE format('GRANT INSERT ON TABLE finance_entry TO %I', r);

           -- The team directory as a view, so password_hash is unreachable
           -- rather than merely unselected.
           EXECUTE format('GRANT SELECT ON app.team_directory TO %I', r);

           -- Only the context helpers. Notably NOT app.issue_document, which
           -- is SECURITY DEFINER and would mint an invoice number.
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_user_id() TO %I', r);
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_user_role() TO %I', r);
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.is_agent() TO %I', r);
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.agent_user_id() TO %I', r);
         END
         $$;`,
      );


      console.log(`[grants] agent role "${agentUser}" — read-only plus 3 narrow inserts, no UPDATE or DELETE`);
    } else {
      console.log('[grants] AGENT_DB_USER/PASSWORD not set — agent role skipped');
    }

    // ---------------------------------------------------------------------
    // The work agent role.
    //
    // Differs from the finance agent in one way that matters: it must UPDATE.
    // Assigning a task IS an update. So instead of withholding the verb, the
    // grant NARROWS it — column-level UPDATE on exactly three columns.
    //
    // A column grant is checked per statement: an UPDATE naming `status` is
    // refused by PostgreSQL before any policy or trigger runs. That is what
    // stops the agent marking work complete; the trigger in 0028 says the same
    // thing again where a reader will look for it.
    //
    // It has no grant at all on document, finance_entry, service_price or
    // fiscal_rate. It cannot learn what anything costs.
    // ---------------------------------------------------------------------
    const workUser = process.env.WORK_AGENT_DB_USER;
    const workPassword = process.env.WORK_AGENT_DB_PASSWORD;

    if (workUser && workPassword) {
      await client.query(
        `DO $$
         DECLARE r text := ${literal(workUser)}; p text := ${literal(workPassword)};
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
         DECLARE
           r text := ${literal(workUser)};
           readable text[] := ARRAY['company','project','task','effort_log','capacity','comment'];
           t text;
         BEGIN
           EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
           EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
           EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', r);
           EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);

           -- Reset first, so removing a table from the list above takes the
           -- grant away rather than leaving it behind.
           EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
           EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);

           FOREACH t IN ARRAY readable LOOP
             EXECUTE format('GRANT SELECT ON TABLE %I TO %I', t, r);
           END LOOP;

           EXECUTE format('GRANT INSERT ON TABLE task TO %I', r);
           EXECUTE format('GRANT INSERT ON TABLE comment TO %I', r);

           -- The audit log. Creating a task fires the activity trigger, which
           -- runs as the caller — so without this the agent cannot act at all.
           -- INSERT only: the activity table is append-only, so it can write
           -- its own trail and never edit it. An agent that could act without
           -- being logged would be the worst of both worlds.
           EXECUTE format('GRANT INSERT ON TABLE activity TO %I', r);

           -- The narrowing. Three columns, named explicitly. An UPDATE that
           -- mentions status, title or project_id is refused by the grant.
           EXECUTE format('GRANT UPDATE (assignee_id, due_date, priority) ON TABLE task TO %I', r);

           EXECUTE format('GRANT SELECT ON app.team_directory TO %I', r);
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_user_id() TO %I', r);
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_user_role() TO %I', r);
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.is_work_agent() TO %I', r);
           EXECUTE format('GRANT EXECUTE ON FUNCTION app.work_agent_user_id() TO %I', r);
         END
         $$;`,
      );

      console.log(`[grants] work agent role "${workUser}" — reads work, may assign and reschedule, never completes`);
    } else {
      console.log('[grants] WORK_AGENT_DB_USER/PASSWORD not set — work agent role skipped');
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

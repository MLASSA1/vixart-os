/**
 * VIXART OS — rôle applicatif et privilèges (idempotent).
 *
 * Exécuté à chaque démarrage du conteneur `app`, avant le serveur.
 *
 * Pourquoi ce n'est pas une migration : les rôles PostgreSQL vivent au niveau
 * du cluster et non de la base ; `pg_dump` ne les restaure pas, et les GRANT
 * sont retirés par `--no-privileges`. Ce script rétablit donc l'état attendu
 * après n'importe quelle restauration, sans jamais toucher aux données.
 *
 * Le rôle créé ici est volontairement faible :
 *   - NOSUPERUSER, NOBYPASSRLS → le Row Level Security s'applique vraiment
 *   - aucun droit de DDL       → il ne peut ni créer ni supprimer une table
 */

import { Client } from 'pg';

function requireEnv(nom: string): string {
  const valeur = process.env[nom];
  if (!valeur) throw new Error(`Variable d'environnement manquante : ${nom}`);
  return valeur;
}

async function main() {
  const ownerUrl = requireEnv('DATABASE_URL');
  const appUser = requireEnv('APP_DB_USER');
  const appPassword = requireEnv('APP_DB_PASSWORD');

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();

  try {
    // CREATE ROLE / ALTER ROLE n'acceptent pas de paramètre lié : on passe par
    // un bloc DO, où `format()` avec %I / %L fait l'échappement correctement.
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

         -- Les tables créées par les migrations futures héritent automatiquement.
         EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', r);
         EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r);
         EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', r);
       END
       $$;`,
    );

    // Le journal de migrations reste hors de portée de l'application.
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

    console.log(`[grants] rôle « ${appUser} » synchronisé (NOBYPASSRLS, sans DDL)`);
  } finally {
    await client.end();
  }
}

/** Littéral SQL échappé — utilisé uniquement pour des noms de rôle. */
function literal(valeur: string): string {
  return `'${valeur.replace(/'/g, "''")}'`;
}

main().catch((erreur) => {
  console.error('[grants] ÉCHEC :', erreur);
  process.exit(1);
});

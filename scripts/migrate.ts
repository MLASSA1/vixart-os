/**
 * VIXART OS — application des migrations.
 *
 * Lit les fichiers SQL numérotés de `drizzle/` et n'applique que ceux qui
 * manquent, en les enregistrant dans le journal `drizzle.__drizzle_migrations`.
 *
 * ⚠️  C'est le SEUL chemin autorisé pour modifier le schéma en production.
 *     `drizzle-kit push` n'est jamais exécuté sur une base contenant des
 *     données réelles : il altère le schéma sans trace et peut détruire des
 *     colonnes silencieusement.
 *
 * Idempotent : relancer ce script sur une base à jour ne fait rien.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import path from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL manquant : voir .env.example");

  const dossier = path.resolve(process.cwd(), 'drizzle');
  console.log(`[migrate] dossier : ${dossier}`);

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const avant = await compterMigrations(client);
    const db = drizzle(client);

    await migrate(db, { migrationsFolder: dossier });

    const apres = await compterMigrations(client);
    const appliquees = apres - avant;

    if (appliquees === 0) {
      console.log(`[migrate] base déjà à jour (${apres} migration(s) au journal)`);
    } else {
      console.log(`[migrate] ${appliquees} migration(s) appliquée(s) — total ${apres}`);
    }
  } finally {
    await client.end();
  }
}

async function compterMigrations(client: Client): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT COALESCE(count(*), 0)::text AS n
       FROM information_schema.tables t
       LEFT JOIN LATERAL (SELECT 1) _ ON true
      WHERE t.table_schema = 'drizzle' AND t.table_name = '__drizzle_migrations'`,
  );
  if (!rows[0] || rows[0].n === '0') return 0;

  const { rows: total } = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations',
  );
  return Number(total[0]?.n ?? 0);
}

main().catch((erreur) => {
  console.error('[migrate] ÉCHEC :', erreur);
  process.exit(1);
});

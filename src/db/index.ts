/**
 * VIXART OS — connexions à la base.
 *
 * Deux pools distincts, deux rôles PostgreSQL distincts :
 *
 *   `db`      → rôle applicatif (APP_DATABASE_URL), NOBYPASSRLS.
 *               Utilisé par toutes les requêtes issues d'une requête HTTP.
 *               Le Row Level Security s'applique à lui.
 *
 *   `dbOwner` → rôle propriétaire (DATABASE_URL). Migrations, amorçage et
 *               diagnostics de démarrage. Jamais depuis une route métier.
 *
 * Les deux pools sont créés paresseusement : `next build` importe ce module
 * pour analyser les routes, sans qu'aucune base ne soit joignable à ce moment.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema';

// ---------------------------------------------------------------------------
// Analyseurs de types pg — appliqués une fois, avant toute connexion.
// ---------------------------------------------------------------------------

// OID 20 = int8/BIGINT. Par défaut, `pg` renvoie une chaîne. On veut un bigint :
// un montant en centimes ne doit jamais transiter par un Number.
types.setTypeParser(20, (valeur: string) => BigInt(valeur));

// OID 1082 = date. On garde la chaîne ISO `YYYY-MM-DD` : pas de dérive de
// fuseau horaire sur les échéances ou les dates d'entrée en vigueur.
types.setTypeParser(1082, (valeur: string) => valeur);

// OID 1700 = numeric. Interdit dans ce schéma ; s'il apparaît un jour, il reste
// une chaîne plutôt que d'être converti silencieusement en flottant.
types.setTypeParser(1700, (valeur: string) => valeur);

// ---------------------------------------------------------------------------

export type Database = NodePgDatabase<typeof schema>;

function requireEnv(nom: string): string {
  const valeur = process.env[nom];
  if (!valeur) {
    throw new Error(`Variable d'environnement manquante : ${nom}. Voir .env.example.`);
  }
  return valeur;
}

function creerPool(url: string, max: number): Pool {
  return new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Imposé par le conteneur ; rappelé ici pour les exécutions hors Docker.
    options: '-c timezone=Africa/Casablanca',
  });
}

// En développement, Next.js recharge les modules à chaud : sans ce cache global
// on ouvrirait un pool par rechargement jusqu'à saturer PostgreSQL.
const cache = globalThis as unknown as {
  __vixartDbApp?: Database;
  __vixartDbOwner?: Database;
};

/** Connexion applicative — soumise au RLS. Créée au premier usage. */
export function getDb(): Database {
  if (!cache.__vixartDbApp) {
    cache.__vixartDbApp = drizzle(creerPool(requireEnv('APP_DATABASE_URL'), 10), {
      schema,
      casing: 'snake_case',
    });
  }
  return cache.__vixartDbApp;
}

/**
 * Connexion propriétaire — contourne le pool applicatif et ses politiques.
 * Réservée aux migrations, à l'amorçage et aux diagnostics de démarrage.
 */
export function getOwnerDb(): Database {
  if (!cache.__vixartDbOwner) {
    cache.__vixartDbOwner = drizzle(creerPool(requireEnv('DATABASE_URL'), 2), {
      schema,
      casing: 'snake_case',
    });
  }
  return cache.__vixartDbOwner;
}

/**
 * Alias ergonomique de `getDb()`. Le Proxy diffère la création du pool au
 * premier accès : importer `db` ne connecte rien.
 */
export const db: Database = new Proxy({} as Database, {
  get(_cible, propriete, recepteur) {
    const reel = getDb() as unknown as Record<string | symbol, unknown>;
    const valeur = Reflect.get(reel, propriete, recepteur);
    return typeof valeur === 'function' ? valeur.bind(reel) : valeur;
  },
});

export { schema };

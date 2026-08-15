/**
 * VIXART OS — amorçage de la base.
 *
 * IDEMPOTENT. Ne s'exécute que si la table `client` est vide, et chaque
 * insertion est protégée par ON CONFLICT DO NOTHING. Relancer ce script sur une
 * base contenant des données réelles ne modifie et n'écrase rien.
 *
 * Les données ci-dessous sont le pipeline réel de VIXART, pas des exemples.
 * Aucun prix n'est inventé : le catalogue de services (phase 2) sera amorcé
 * à 0 DH, Amin fixe lui-même la tarification.
 */

import { hash } from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Client as PgClient } from 'pg';
import { appUser, client, fiscalRate } from '../src/db/schema';
import { TAUX_AMORCAGE } from '../src/lib/fiscal';

// ---------------------------------------------------------------------------
// L'équipe — les cinq seuls comptes du système. Pas d'inscription publique.
//
// Hypothèse : adresses internes @vixart.ma. Si le domaine de messagerie diffère,
// modifier ici AVANT le premier démarrage, ou changer l'adresse dans l'écran
// Équipe une fois connecté.
// ---------------------------------------------------------------------------

const EQUIPE = [
  {
    email: 'amin@vixart.ma',
    fullName: 'Amin',
    jobTitle: 'Founder / CEO',
    role: 'admin' as const,
  },
  {
    email: 'aymen@vixart.ma',
    fullName: 'Aymen',
    jobTitle: 'Cinematic Director',
    role: 'member' as const,
  },
  {
    email: 'azzedine@vixart.ma',
    fullName: 'Azzedine',
    jobTitle: 'Editor & Motion Design',
    role: 'member' as const,
  },
  {
    email: 'adam@vixart.ma',
    fullName: 'Adam',
    jobTitle: 'Community & Social Media Manager',
    role: 'member' as const,
  },
  {
    email: 'mohamed.amine@vixart.ma',
    fullName: 'Mohamed Amine',
    jobTitle: 'Creative Director & Designer',
    role: 'member' as const,
  },
];

// ---------------------------------------------------------------------------
// Le pipeline réel. ICE et IF laissés vides : ils seront saisis fiche par fiche
// à partir des documents officiels des clients. Un ICE inventé sur une facture
// est une facture fausse.
// ---------------------------------------------------------------------------

const PIPELINE = [
  {
    name: 'Bader Training Center',
    status: 'client' as const,
    city: 'Agadir',
    engagementSummary:
      'Refonte du site + tableau de bord de gestion des clients (suivi des inscriptions et des sessions).',
    notes: null,
  },
  {
    name: 'Laboratoire Talborjt',
    status: 'client' as const,
    city: 'Agadir',
    engagementSummary: "Laboratoire d'analyses médicales — présence digitale.",
    notes: null,
  },
  {
    name: 'SILACOD',
    status: 'client' as const,
    city: 'Agadir',
    website: 'https://silacod.com',
    engagementSummary:
      'Plateforme de dropshipping en marque blanche — production des parcours de tutoriels vidéo.',
    notes: null,
  },
  {
    name: 'Yansin',
    status: 'client' as const,
    city: 'Agadir',
    engagementSummary: 'Chaussure agadirie — construction du système de croissance.',
    notes: null,
  },
  {
    name: 'Client Podcast',
    status: 'client' as const,
    engagementSummary: "Croissance d'audience du podcast.",
    notes:
      'Nom commercial à renseigner par Amin — fiche créée à partir du pipeline existant.',
  },
  {
    name: 'Lion Park Agadir',
    status: 'prospect' as const,
    city: 'Drarga',
    engagementSummary: 'Parc safari de Drarga — proposition en cours.',
    notes: null,
  },
  {
    name: 'Roastery Agadir',
    status: 'prospect' as const,
    city: 'Agadir',
    engagementSummary:
      "Audit concurrentiel + proposition d'investissement.",
    notes: null,
  },
  {
    name: 'Sidi Fares',
    status: 'dormant' as const,
    engagementSummary: 'Référence — étude de cas pilier.',
    notes: 'Mission close. Conservée comme référence commerciale.',
  },
  {
    name: 'ARMURE',
    status: 'dormant' as const,
    engagementSummary: 'Référence — étude de cas parfum D2C.',
    notes: 'Mission close. Conservée comme référence commerciale.',
  },
];

// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant : voir .env.example');

  const motDePasse = process.env.SEED_DEFAULT_PASSWORD;
  if (!motDePasse || motDePasse.length < 10) {
    throw new Error(
      'SEED_DEFAULT_PASSWORD manquant ou trop court (10 caractères minimum). Voir .env.example.',
    );
  }

  const pg = new PgClient({ connectionString: url });
  await pg.connect();

  try {
    // Le RLS est en FORCE, y compris pour le propriétaire des tables.
    // Cette porte explicite n'est ouverte que par les scripts de démarrage.
    await pg.query("SET app.bootstrap = 'on'");

    const db = drizzle(pg, { casing: 'snake_case' });

    // --- Garde d'idempotence : le seed ne s'exécute que sur une base vierge ---
    const { rows } = await pg.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM client',
    );
    const clientsExistants = Number(rows[0]?.n ?? 0);

    if (clientsExistants > 0) {
      console.log(
        `[seed] ${clientsExistants} client(s) déjà en base — amorçage ignoré, aucune donnée touchée.`,
      );
      return;
    }

    console.log('[seed] base vierge — amorçage');

    // --- Paramètres fiscaux versionnés ---
    for (const taux of TAUX_AMORCAGE) {
      await db
        .insert(fiscalRate)
        .values({
          key: taux.cle,
          rateBp: taux.pdb,
          effectiveFrom: taux.effectiveFrom,
          note: taux.note,
        })
        .onConflictDoNothing();
    }
    console.log(`[seed] ${TAUX_AMORCAGE.length} paramètre(s) fiscal(aux)`);

    // --- Équipe ---
    // Coût bcrypt 12 : ~250 ms par hash, dissuasif hors ligne, indolore ici.
    const hashCommun = await hash(motDePasse, 12);
    for (const membre of EQUIPE) {
      await db
        .insert(appUser)
        .values({ ...membre, passwordHash: hashCommun })
        .onConflictDoNothing();
    }
    console.log(`[seed] ${EQUIPE.length} comptes d'équipe (mot de passe initial commun)`);

    // --- Pipeline ---
    for (const fiche of PIPELINE) {
      await db.insert(client).values(fiche).onConflictDoNothing();
    }

    const parStatut = PIPELINE.reduce<Record<string, number>>((acc, f) => {
      acc[f.status] = (acc[f.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[seed] ${PIPELINE.length} fiches clients — ` +
        Object.entries(parStatut)
          .map(([s, n]) => `${n} ${s}`)
          .join(', '),
    );

    await db.execute(sql`SELECT 1`);
    console.log('[seed] terminé');
  } finally {
    await pg.end();
  }
}

main().catch((erreur) => {
  console.error('[seed] ÉCHEC :', erreur);
  process.exit(1);
});

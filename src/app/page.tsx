import { sql } from 'drizzle-orm';
import { db, getOwnerDb } from '@/db';

/**
 * PHASE 0 — écran d'état de la fondation.
 *
 * Cet écran est temporaire : il prouve que la base répond, que les migrations
 * sont passées, que l'amorçage a eu lieu et que le Row Level Security est
 * réellement actif. La phase 4 le remplace par le tableau de bord.
 *
 * Il n'est volontairement pas protégé par authentification — il n'y en a pas
 * encore (phase 1) — et il n'expose aucune donnée client : uniquement des
 * compteurs et l'état du moteur.
 */
export const dynamic = 'force-dynamic';

interface Diagnostic {
  versionPg: string;
  baseNom: string;
  repertoireDonnees: string;
  tailleBase: string;
  migrations: number;
  clients: number;
  equipe: number;
  tauxFiscaux: number;
  /** Lignes visibles par le rôle applicatif SANS session : doit valoir 0. */
  clientsVisiblesSansSession: number;
  rlsForce: number;
  erreur: string | null;
}

async function lireDiagnostic(): Promise<Diagnostic> {
  const owner = getOwnerDb();

  const [moteur] = (
    await owner.execute<{
      version_pg: string;
      base_nom: string;
      repertoire: string;
      taille: string;
    }>(sql`
      SELECT split_part(version(), ' ', 2) AS version_pg,
             current_database()            AS base_nom,
             current_setting('data_directory') AS repertoire,
             pg_size_pretty(pg_database_size(current_database())) AS taille
    `)
  ).rows;

  const [compteurs] = (
    await owner.execute<{
      migrations: string;
      clients: string;
      equipe: string;
      taux: string;
      rls_force: string;
    }>(sql`
      SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS migrations,
             (SELECT count(*) FROM client)::text                       AS clients,
             (SELECT count(*) FROM app_user)::text                     AS equipe,
             (SELECT count(*) FROM fiscal_rate)::text                  AS taux,
             (SELECT count(*) FROM pg_class
               WHERE relrowsecurity AND relforcerowsecurity
                 AND relnamespace = 'public'::regnamespace)::text      AS rls_force
    `)
  ).rows;

  // Lecture par le rôle applicatif, sans contexte de session : le RLS doit
  // renvoyer zéro ligne. Si ce compteur n'est pas à 0, la sécurité est ouverte.
  let clientsVisiblesSansSession = -1;
  let erreur: string | null = null;
  try {
    const res = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM client`);
    clientsVisiblesSansSession = Number(res.rows[0]?.n ?? -1);
  } catch (e) {
    erreur = e instanceof Error ? e.message : String(e);
  }

  return {
    versionPg: moteur?.version_pg ?? '?',
    baseNom: moteur?.base_nom ?? '?',
    repertoireDonnees: moteur?.repertoire ?? '?',
    tailleBase: moteur?.taille ?? '?',
    migrations: Number(compteurs?.migrations ?? 0),
    clients: Number(compteurs?.clients ?? 0),
    equipe: Number(compteurs?.equipe ?? 0),
    tauxFiscaux: Number(compteurs?.taux ?? 0),
    rlsForce: Number(compteurs?.rls_force ?? 0),
    clientsVisiblesSansSession,
    erreur,
  };
}

function Ligne({ cle, valeur }: { cle: string; valeur: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-void/10 py-3">
      <span className="meta" style={{ opacity: 0.52 }}>
        {cle}
      </span>
      <span className="montant text-right">{valeur}</span>
    </div>
  );
}

export default async function EtatFondation() {
  const d = await lireDiagnostic();
  const rlsOk = d.clientsVisiblesSansSession === 0;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="border-b-2 border-void pb-6">
        <p className="meta" style={{ opacity: 0.52 }}>
          SOCIETE VIXART SARL — RC 69627 — ICE 003979570000062
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">VIXART OS</h1>
        <p className="meta mt-2" style={{ opacity: 0.68 }}>
          Phase 0 — Fondation
        </p>
      </header>

      <section className="mt-12">
        <h2 className="meta border-b border-void pb-2">Moteur</h2>
        <div className="mt-2">
          <Ligne cle="PostgreSQL" valeur={d.versionPg} />
          <Ligne cle="Base" valeur={d.baseNom} />
          <Ligne cle="Répertoire de données" valeur={d.repertoireDonnees} />
          <Ligne cle="Taille" valeur={d.tailleBase} />
          <Ligne cle="Migrations appliquées" valeur={String(d.migrations)} />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="meta border-b border-void pb-2">Données amorcées</h2>
        <div className="mt-2">
          <Ligne cle="Fiches clients" valeur={String(d.clients)} />
          <Ligne cle="Comptes d'équipe" valeur={String(d.equipe)} />
          <Ligne cle="Paramètres fiscaux" valeur={String(d.tauxFiscaux)} />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="meta border-b border-void pb-2">Row Level Security</h2>
        <div className="mt-2">
          <Ligne cle="Tables en FORCE RLS" valeur={String(d.rlsForce)} />
          <Ligne
            cle="Clients lus sans session"
            valeur={d.erreur ? 'erreur' : String(d.clientsVisiblesSansSession)}
          />
        </div>

        {/* État encodé par la structure et la graisse, jamais par la couleur. */}
        <div
          className={
            rlsOk
              ? 'mt-6 border border-void/20 px-5 py-4'
              : 'mt-6 border-2 border-void bg-void px-5 py-4 text-pure'
          }
        >
          <p className="meta">{rlsOk ? 'Cloison active' : 'ALERTE — CLOISON OUVERTE'}</p>
          <p className="prose-vixart mt-2" style={{ opacity: rlsOk ? 0.68 : 1 }}>
            {rlsOk
              ? "Le rôle applicatif ne lit aucune fiche client tant qu'aucune session n'est établie. Le cloisonnement est appliqué par PostgreSQL, pas par l'interface."
              : `Le rôle applicatif lit ${d.clientsVisiblesSansSession} ligne(s) sans session. Ne pas mettre en production.`}
          </p>
          {d.erreur && (
            <p className="prose-vixart mt-2" style={{ opacity: 0.68 }}>
              {d.erreur}
            </p>
          )}
        </div>
      </section>

      <footer className="mt-16 border-t border-void/10 pt-6">
        <p className="meta" style={{ opacity: 0.52 }}>
          Prochaine étape — Phase 1 : authentification et CRM
        </p>
      </footer>
    </main>
  );
}

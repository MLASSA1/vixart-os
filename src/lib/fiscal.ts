/**
 * VIXART OS — paramètres fiscaux versionnés et calcul des totaux de document.
 *
 * PRINCIPE : aucun taux n'est écrit en dur dans le code applicatif. Tous les
 * taux vivent dans la table `fiscal_rate`, avec une date `effective_from`.
 * Un taux n'est jamais modifié : on insère une nouvelle version. Un document
 * déjà émis conserve le taux copié sur lui-même au moment de l'émission —
 * il n'est JAMAIS relu depuis cette table à l'affichage.
 *
 * Les constantes ci-dessous ne sont que des valeurs d'amorçage (seed) pour un
 * cluster vierge, pas la source de vérité à l'exécution.
 */

import {
  appliquerTaux,
  somme,
  totalLigne,
  type BasisPoints,
  type Centimes,
  type Millis,
} from './money';

// ---------------------------------------------------------------------------
// Clés de paramètres
// ---------------------------------------------------------------------------

export const CLES_FISCALES = {
  /** TVA de droit commun applicable aux prestations de publicité. */
  TVA_STANDARD: 'tva_standard',
  /**
   * Retenue à la source sur la TVA — art. 117 bis du CGI.
   * Part de la TVA que certains clients retiennent et reversent eux-mêmes.
   */
  RETENUE_SOURCE_TVA: 'retenue_source_tva',
} as const;

export type CleFiscale = (typeof CLES_FISCALES)[keyof typeof CLES_FISCALES];

/**
 * Valeurs d'amorçage.
 *
 * TVA standard : 20 % — taux de droit commun sur les prestations de publicité.
 *
 * Retenue à la source : amorcée à 0 DÉLIBÉRÉMENT. Le taux applicable dépend de
 * la situation fiscale du prestataire et du client ; il doit être saisi par le
 * gérant à partir de l'avis de la fiduciaire, pas deviné par un développeur.
 * Tant qu'il vaut 0, « Net à encaisser » est égal au « Total TTC ».
 */
export const TAUX_AMORCAGE: ReadonlyArray<{
  cle: CleFiscale;
  pdb: BasisPoints;
  effectiveFrom: string;
  note: string;
}> = [
  {
    cle: CLES_FISCALES.TVA_STANDARD,
    pdb: 2000,
    effectiveFrom: '2026-01-01',
    note: 'TVA de droit commun — prestations de publicité (agence).',
  },
  {
    cle: CLES_FISCALES.RETENUE_SOURCE_TVA,
    pdb: 0,
    effectiveFrom: '2026-01-01',
    note:
      'À DÉFINIR PAR LE GÉRANT (art. 117 bis CGI). Valeur nulle tant que la ' +
      'fiduciaire n’a pas confirmé le taux applicable. Ne pas deviner : ' +
      'ajouter une nouvelle version datée plutôt que modifier celle-ci.',
  },
];

// ---------------------------------------------------------------------------
// Sélection de la version applicable
// ---------------------------------------------------------------------------

export interface VersionTaux {
  cle: string;
  /** Taux en points de base. */
  rateBp: number;
  /** Date d'entrée en vigueur, format ISO `YYYY-MM-DD`. */
  effectiveFrom: string;
  note: string | null;
}

/**
 * Retourne la version en vigueur d'un taux à une date donnée : la plus récente
 * dont `effective_from` est antérieure ou égale à la date.
 *
 * Fonction pure — testable sans base de données.
 */
export function versionApplicable(
  versions: readonly VersionTaux[],
  cle: CleFiscale,
  date: string,
): VersionTaux | null {
  const candidates = versions
    .filter((v) => v.cle === cle && v.effectiveFrom <= date)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Totaux d'un document
// ---------------------------------------------------------------------------

export interface LigneDocument {
  /** Prix unitaire figé sur le document, en centimes. */
  prixUnitaire: Centimes;
  /** Quantité en millièmes d'unité. */
  quantite: Millis;
}

export interface EntreeTotaux {
  lignes: readonly LigneDocument[];
  /** Taux de TVA figé sur le document, en points de base (2000 = 20 %). */
  tvaRateBp: BasisPoints;
  /** Le client applique-t-il la retenue à la source ? */
  retenueSource: boolean;
  /** Taux de retenue figé sur le document, en points de base. */
  retenueRateBp: BasisPoints;
}

export interface Totaux {
  /** Total hors taxes. */
  totalHt: Centimes;
  /** Montant de TVA. */
  totalTva: Centimes;
  /** Total toutes taxes comprises. */
  totalTtc: Centimes;
  /** Part de TVA retenue à la source par le client (0 si non applicable). */
  retenue: Centimes;
  /** Ce que VIXART encaisse réellement : TTC − retenue. */
  netAEncaisser: Centimes;
}

/**
 * Calcule les totaux d'un document. Entièrement en centimes, entièrement en
 * bigint. La TVA est calculée sur le total HT arrondi, pas ligne à ligne :
 * c'est la méthode retenue pour que l'addition affichée soit toujours exacte.
 */
export function calculerTotaux(entree: EntreeTotaux): Totaux {
  const totalHt = somme(entree.lignes.map((l) => totalLigne(l.prixUnitaire, l.quantite)));
  const totalTva = appliquerTaux(totalHt, entree.tvaRateBp);
  const totalTtc = totalHt + totalTva;

  const retenue =
    entree.retenueSource && entree.retenueRateBp > 0
      ? appliquerTaux(totalTva, entree.retenueRateBp)
      : 0n;

  return {
    totalHt,
    totalTva,
    totalTtc,
    retenue,
    netAEncaisser: totalTtc - retenue,
  };
}

/**
 * Une TVA à 0 % exige une justification écrite (exonération, export, etc.).
 * Contrainte doublée côté base par un CHECK — ceci n'est que le garde-fou UI.
 */
export function justificationRequise(tvaRateBp: BasisPoints): boolean {
  return tvaRateBp === 0;
}

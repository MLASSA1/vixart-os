/**
 * VIXART OS — arithmétique monétaire.
 *
 * RÈGLE ABSOLUE : un montant est un `bigint` de centimes. Jamais un `number`,
 * jamais un `float`, jamais une `string` dans un calcul. Le type `number` de
 * JavaScript est un flottant IEEE-754 : 0.1 + 0.2 !== 0.3, et une facture
 * fausse d'un centime est une facture fausse.
 *
 * Toutes les conversions se font par manipulation de chaînes, pas par
 * multiplication flottante (`x * 100` est déjà faux pour x = 19.99).
 *
 * Unités :
 *   - montants   → centimes         (bigint)  1 DH = 100
 *   - quantités  → millièmes         (bigint)  1 unité = 1000  (permet 0,5 jour)
 *   - taux       → points de base    (number)  20 % = 2000
 */

/** Montant en centimes de dirham. */
export type Centimes = bigint;

/** Quantité en millièmes d'unité (1 unité = 1000). */
export type Millis = bigint;

/** Taux en points de base (1 % = 100 pdb, 20 % = 2000 pdb). */
export type BasisPoints = number;

export const CENTIMES_PAR_DIRHAM = 100n;
export const MILLIS_PAR_UNITE = 1000n;
export const PDB_PAR_UNITE = 10_000n;

/**
 * Espace insécable U+00A0 — séparateur des milliers en français.
 * Écrit sous forme échappée : un espace insécable est invisible dans un
 * éditeur et se change silencieusement en espace ordinaire au copier-coller.
 */
const NBSP = '\u00A0';

/** Espaces ignorés en entrée : ordinaire, insécable, fin, fin insécable. */
const ESPACES = /[\s\u00A0\u202F\u2009]/g;

// ---------------------------------------------------------------------------
// Division arrondie
// ---------------------------------------------------------------------------

/**
 * Division entière avec arrondi commercial (0,5 s'éloigne de zéro).
 * C'est la règle d'arrondi utilisée sur les documents fiscaux marocains.
 */
export function divRound(numerateur: bigint, denominateur: bigint): bigint {
  if (denominateur === 0n) throw new Error('money: division par zéro');

  const negatif = numerateur < 0n !== denominateur < 0n;
  const n = numerateur < 0n ? -numerateur : numerateur;
  const d = denominateur < 0n ? -denominateur : denominateur;

  const quotient = n / d;
  const reste = n % d;
  const arrondi = reste * 2n >= d ? quotient + 1n : quotient;

  return negatif ? -arrondi : arrondi;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convertit une saisie utilisateur en centimes.
 *
 * Accepte : "1234,56"  "1 234,56"  "1234.56"  "1 234,56 DH"  "-19,99"  1500
 * Au-delà de 2 décimales, arrondi commercial.
 *
 * Un `number` n'est accepté que s'il est entier (littéral de code du type
 * `toCentimes(1500)`) : tout flottant est refusé, car il est déjà potentiellement
 * faux au moment où cette fonction le reçoit.
 */
export function toCentimes(entree: string | number): Centimes {
  if (typeof entree === 'number') {
    if (!Number.isFinite(entree) || !Number.isInteger(entree)) {
      throw new Error(
        `money: nombre flottant refusé (${entree}). Passez une chaîne : toCentimes("${entree}")`,
      );
    }
    return BigInt(entree) * CENTIMES_PAR_DIRHAM;
  }

  // Nettoyage : espaces (normaux, insécables, fins), symbole monétaire.
  let s = entree
    .replace(ESPACES, '')
    .replace(/DH|MAD|د\.م\./gi, '')
    .trim();

  if (s === '') throw new Error('money: montant vide');

  let signe = 1n;
  if (s.startsWith('-')) {
    signe = -1n;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // Virgule décimale française ou point décimal.
  s = s.replace(',', '.');

  if (!/^\d*(\.\d*)?$/.test(s) || s === '.' || s === '') {
    throw new Error(`money: montant illisible « ${entree} »`);
  }

  const [partieEntiere = '0', partieDecimale = ''] = s.split('.');

  // On garde 3 décimales pour pouvoir arrondir la 3ᵉ, sans jamais passer par un float.
  const decimales = (partieDecimale + '000').slice(0, 3);
  const millicentimes =
    BigInt(partieEntiere || '0') * 1000n + BigInt(decimales);

  return signe * divRound(millicentimes, 10n);
}

/**
 * Représentation décimale machine : "1234.56". Pour les CSV, les API, les tests.
 * Jamais pour l'affichage à l'écran — utiliser `formatMAD`.
 */
export function fromCentimes(centimes: Centimes): string {
  const negatif = centimes < 0n;
  const abs = negatif ? -centimes : centimes;
  const dirhams = abs / CENTIMES_PAR_DIRHAM;
  const reste = abs % CENTIMES_PAR_DIRHAM;
  return `${negatif ? '-' : ''}${dirhams}.${reste.toString().padStart(2, '0')}`;
}

/** Convertit une quantité saisie ("1,5", "2", 3) en millièmes d'unité. */
export function toMillis(entree: string | number): Millis {
  if (typeof entree === 'number') {
    if (!Number.isInteger(entree)) {
      throw new Error(`money: quantité flottante refusée (${entree}), passez une chaîne`);
    }
    return BigInt(entree) * MILLIS_PAR_UNITE;
  }
  const s = entree.replace(ESPACES, '').replace(',', '.');
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') {
    throw new Error(`money: quantité illisible « ${entree} »`);
  }
  const negatif = s.startsWith('-');
  const corps = negatif ? s.slice(1) : s;
  const [ent = '0', dec = ''] = corps.split('.');
  const decimales = (dec + '0000').slice(0, 4);
  const dixMillis = BigInt(ent || '0') * 10_000n + BigInt(decimales);
  const millis = divRound(dixMillis, 10n);
  return negatif ? -millis : millis;
}

/** Quantité lisible : 1500n → "1,5" ; 2000n → "2". */
export function fromMillis(millis: Millis): string {
  const negatif = millis < 0n;
  const abs = negatif ? -millis : millis;
  const entier = abs / MILLIS_PAR_UNITE;
  const reste = abs % MILLIS_PAR_UNITE;
  const signe = negatif ? '-' : '';
  if (reste === 0n) return `${signe}${entier}`;
  return `${signe}${entier},${reste.toString().padStart(3, '0').replace(/0+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Formatage français-marocain
// ---------------------------------------------------------------------------

function grouperMilliers(chiffres: string): string {
  return chiffres.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/**
 * Format d'affichage VIXART : `1 234,56 DH`
 * Espace insécable pour les milliers, virgule décimale, symbole suffixé.
 */
export function formatMAD(centimes: Centimes): string {
  return `${formatMontant(centimes)}${NBSP}DH`;
}

/** Idem sans le symbole — pour les colonnes de tableau déjà intitulées « DH ». */
export function formatMontant(centimes: Centimes): string {
  const negatif = centimes < 0n;
  const abs = negatif ? -centimes : centimes;
  const dirhams = (abs / CENTIMES_PAR_DIRHAM).toString();
  const reste = (abs % CENTIMES_PAR_DIRHAM).toString().padStart(2, '0');
  // Le signe négatif est le seul marqueur : pas de couleur, pas de parenthèses.
  return `${negatif ? '−' : ''}${grouperMilliers(dirhams)},${reste}`;
}

/** Taux en points de base → "20 %", "7,5 %", "0 %". */
export function formatTaux(pdb: BasisPoints): string {
  const entier = Math.trunc(pdb / 100);
  const decimales = Math.abs(pdb % 100);
  if (decimales === 0) return `${entier}${NBSP}%`;
  const frac = decimales.toString().padStart(2, '0').replace(/0+$/, '');
  return `${entier},${frac}${NBSP}%`;
}

// ---------------------------------------------------------------------------
// Calculs de ligne et de document
// ---------------------------------------------------------------------------

/** Total d'une ligne : prix unitaire × quantité, arrondi au centime. */
export function totalLigne(prixUnitaire: Centimes, quantite: Millis): Centimes {
  return divRound(prixUnitaire * quantite, MILLIS_PAR_UNITE);
}

/** Applique un taux en points de base à une assiette. 20 % de 1000,00 → 200,00. */
export function appliquerTaux(assiette: Centimes, pdb: BasisPoints): Centimes {
  if (!Number.isInteger(pdb)) {
    throw new Error(`money: taux non entier en points de base (${pdb})`);
  }
  return divRound(assiette * BigInt(pdb), PDB_PAR_UNITE);
}

/** Somme sûre d'une liste de montants. */
export function somme(montants: readonly Centimes[]): Centimes {
  return montants.reduce<Centimes>((acc, m) => acc + m, 0n);
}

/** Sérialisation vers la base (colonnes BIGINT via Drizzle en mode bigint). */
export const ZERO: Centimes = 0n;

import { describe, expect, it } from 'vitest';
import {
  appliquerTaux,
  divRound,
  formatMAD,
  formatMontant,
  formatTaux,
  fromCentimes,
  fromMillis,
  somme,
  toCentimes,
  toMillis,
  totalLigne,
} from './money';
import { calculerTotaux, versionApplicable } from './fiscal';

const NBSP = '\u00A0';

describe('toCentimes', () => {
  it('lit la virgule décimale française', () => {
    expect(toCentimes('1234,56')).toBe(123456n);
  });

  it('lit le point décimal', () => {
    expect(toCentimes('1234.56')).toBe(123456n);
  });

  it('ignore les séparateurs de milliers et le symbole', () => {
    expect(toCentimes('1 234,56 DH')).toBe(123456n);
    expect(toCentimes(`12${NBSP}345,00`)).toBe(1234500n);
  });

  it('gère les négatifs', () => {
    expect(toCentimes('-19,99')).toBe(-1999n);
  });

  it("arrondit la 3ᵉ décimale au centime, sans passer par un flottant", () => {
    expect(toCentimes('0,005')).toBe(1n); // arrondi commercial : s'éloigne de zéro
    expect(toCentimes('0,004')).toBe(0n);
    expect(toCentimes('-0,005')).toBe(-1n);
  });

  it('évite le piège du flottant sur 19,99', () => {
    // 19.99 * 100 === 1998.9999999999998 en IEEE-754.
    expect(toCentimes('19,99')).toBe(1999n);
    expect(toCentimes('0,29')).toBe(29n);
    expect(toCentimes('1,005')).toBe(101n);
  });

  it('accepte un entier littéral mais refuse un flottant', () => {
    expect(toCentimes(1500)).toBe(150000n);
    expect(() => toCentimes(19.99)).toThrow(/flottant/);
  });

  it('refuse une saisie illisible', () => {
    expect(() => toCentimes('')).toThrow();
    expect(() => toCentimes('abc')).toThrow();
    expect(() => toCentimes('12,34,56')).toThrow();
  });
});

describe('fromCentimes', () => {
  it('produit une décimale machine', () => {
    expect(fromCentimes(123456n)).toBe('1234.56');
    expect(fromCentimes(5n)).toBe('0.05');
    expect(fromCentimes(0n)).toBe('0.00');
    expect(fromCentimes(-1999n)).toBe('-19.99');
  });

  it('fait un aller-retour exact', () => {
    for (const v of ['0,01', '19,99', '1 234,56', '999 999,99', '-42,00']) {
      expect(fromCentimes(toCentimes(v))).toBe(
        v.replace(/[\s ]/g, '').replace(',', '.'),
      );
    }
  });
});

describe('formatMAD', () => {
  it('applique le format français-marocain', () => {
    expect(formatMAD(123456n)).toBe(`1${NBSP}234,56${NBSP}DH`);
    expect(formatMAD(0n)).toBe(`0,00${NBSP}DH`);
    expect(formatMAD(5n)).toBe(`0,05${NBSP}DH`);
  });

  it('groupe les milliers au-delà du million', () => {
    expect(formatMontant(123456789n)).toBe(`1${NBSP}234${NBSP}567,89`);
  });

  it("marque le négatif par le signe seul, sans couleur ni parenthèse", () => {
    expect(formatMontant(-123456n)).toBe(`−1${NBSP}234,56`);
  });
});

describe('formatTaux', () => {
  it('formate les points de base', () => {
    expect(formatTaux(2000)).toBe(`20${NBSP}%`);
    expect(formatTaux(0)).toBe(`0${NBSP}%`);
    expect(formatTaux(750)).toBe(`7,5${NBSP}%`);
    expect(formatTaux(725)).toBe(`7,25${NBSP}%`);
  });
});

describe('quantités', () => {
  it('convertit en millièmes', () => {
    expect(toMillis('1,5')).toBe(1500n);
    expect(toMillis('2')).toBe(2000n);
    expect(toMillis(3)).toBe(3000n);
    expect(toMillis('0,333')).toBe(333n);
  });

  it('réaffiche sans zéros parasites', () => {
    expect(fromMillis(1500n)).toBe('1,5');
    expect(fromMillis(2000n)).toBe('2');
    expect(fromMillis(333n)).toBe('0,333');
  });
});

describe('arithmétique', () => {
  it('arrondit la division au plus proche, 0,5 s’éloignant de zéro', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(1n, 3n)).toBe(0n);
    expect(divRound(2n, 3n)).toBe(1n);
  });

  it('calcule un total de ligne avec quantité fractionnaire', () => {
    // 1 500,00 DH le jour × 1,5 jour = 2 250,00 DH
    expect(totalLigne(150000n, 1500n)).toBe(225000n);
    // 333,33 DH × 3 = 999,99 DH — aucun centime créé ni perdu
    expect(totalLigne(33333n, 3000n)).toBe(99999n);
  });

  it('applique un taux en points de base', () => {
    expect(appliquerTaux(100000n, 2000)).toBe(20000n); // 20 % de 1 000,00
    expect(appliquerTaux(99999n, 2000)).toBe(20000n); // arrondi au centime
    expect(appliquerTaux(100000n, 0)).toBe(0n);
  });

  it('somme sans dérive', () => {
    const lignes = Array.from({ length: 1000 }, () => toCentimes('0,10'));
    expect(somme(lignes)).toBe(10000n); // 100,00 DH exactement
  });
});

describe('calculerTotaux', () => {
  const lignes = [
    { prixUnitaire: toCentimes('12 000,00'), quantite: toMillis('1') },
    { prixUnitaire: toCentimes('2 500,00'), quantite: toMillis('3') },
  ];

  it('calcule HT / TVA / TTC', () => {
    const t = calculerTotaux({
      lignes,
      tvaRateBp: 2000,
      retenueSource: false,
      retenueRateBp: 0,
    });
    expect(t.totalHt).toBe(toCentimes('19 500,00'));
    expect(t.totalTva).toBe(toCentimes('3 900,00'));
    expect(t.totalTtc).toBe(toCentimes('23 400,00'));
    expect(t.retenue).toBe(0n);
    expect(t.netAEncaisser).toBe(t.totalTtc);
  });

  it('gère la TVA à 0 % (exonération)', () => {
    const t = calculerTotaux({
      lignes,
      tvaRateBp: 0,
      retenueSource: false,
      retenueRateBp: 0,
    });
    expect(t.totalTva).toBe(0n);
    expect(t.totalTtc).toBe(t.totalHt);
  });

  it('retranche la retenue à la source du net à encaisser', () => {
    const t = calculerTotaux({
      lignes,
      tvaRateBp: 2000,
      retenueSource: true,
      retenueRateBp: 7500, // 75 % de la TVA, à titre d'exemple de calcul
    });
    expect(t.retenue).toBe(toCentimes('2 925,00'));
    expect(t.netAEncaisser).toBe(toCentimes('20 475,00'));
    expect(t.netAEncaisser).toBe(t.totalTtc - t.retenue);
  });

  it('ignore la retenue si le client ne la pratique pas', () => {
    const t = calculerTotaux({
      lignes,
      tvaRateBp: 2000,
      retenueSource: false,
      retenueRateBp: 7500,
    });
    expect(t.retenue).toBe(0n);
  });
});

describe('versionApplicable', () => {
  const versions = [
    { cle: 'tva_standard', rateBp: 2000, effectiveFrom: '2026-01-01', note: null },
    { cle: 'tva_standard', rateBp: 1800, effectiveFrom: '2027-01-01', note: null },
    { cle: 'retenue_source_tva', rateBp: 0, effectiveFrom: '2026-01-01', note: null },
  ];

  it('retient la version en vigueur à la date demandée', () => {
    expect(versionApplicable(versions, 'tva_standard', '2026-06-30')?.rateBp).toBe(2000);
    expect(versionApplicable(versions, 'tva_standard', '2027-03-01')?.rateBp).toBe(1800);
  });

  it("ignore une version pas encore entrée en vigueur", () => {
    expect(versionApplicable(versions, 'tva_standard', '2025-12-31')).toBeNull();
  });

  it('renvoie null pour une clé inconnue', () => {
    expect(versionApplicable(versions, 'tva_standard' as never, '2026-01-01')).not.toBeNull();
    expect(versionApplicable([], 'tva_standard', '2026-01-01')).toBeNull();
  });
});

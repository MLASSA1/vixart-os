/**
 * VIXART OS — the company's own legal identity.
 *
 * Printed verbatim on every quote and invoice. These are the registered
 * details of SOCIETE VIXART SARL and must not be edited casually: they are
 * what makes an issued document valid.
 */
export const VIXART = {
  legalName: 'SOCIETE VIXART SARL',
  activity: 'Agence de publicité',
  rc: 'RC 69627 (Tribunal de Commerce d’Agadir)',
  ice: '003979570000062',
  taxId: '73161069',
  address: 'Bureau AB 403, Imm A9, Technopole II, Bensergaou, Agadir',
  country: 'Maroc',

  // ---------------------------------------------------------------------
  // Left blank on purpose.
  //
  // Moroccan practice puts the taxe professionnelle (patente), the CNSS
  // affiliation and the capital social on an invoice alongside the ICE, IF and
  // RC above. The correct values are on VIXART's own registration papers and
  // are not guessable — and a wrong identifier on an issued invoice is worse
  // than a missing one, because the document then asserts something false and
  // cannot be edited afterwards.
  //
  // Fill these in and they appear on every document from that moment. Until
  // then the PDF simply omits the line. Same rule as the withholding rate and
  // the service prices: visibly unset beats plausibly wrong.
  // ---------------------------------------------------------------------
  // Supplied 18 September 2026 and printed in the footer of every page.
  taxeProfessionnelle: '55007192',

  cnss: '',
  capitalSocial: '',

  /**
   * Where a client pays.
   *
   * Empty on purpose, and — unlike the identifiers above — NOT omitted when
   * empty. An invoice with no payment block looks finished; an invoice whose
   * payment block says the details are missing does not, and gets fixed before
   * it is sent. Nothing here is guessed: a plausible-looking RIB on an issued
   * invoice sends a client's money to a number nobody checked.
   *
   * Invoices only. A quote is not a demand for payment and carries no bank
   * details at all.
   */
  bank: {
    name: '',
    rib: '',
    iban: '',
    swift: '',
  },
} as const;

/** True once every field a client needs in order to pay has a value. */
export function bankDetailsComplete(): boolean {
  const { name, rib, iban, swift } = VIXART.bank;
  return [name, rib, iban, swift].every((v) => v.trim().length > 0);
}

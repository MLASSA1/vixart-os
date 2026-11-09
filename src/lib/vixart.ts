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
   * MOVED TO THE DATABASE (0081).
   *
   * It lived here, empty, because a plausible-looking RIB on an issued invoice
   * sends a client's money to a number nobody checked — and it stayed empty,
   * which is why every invoice printed "— non renseigné —" in its payment
   * block. Amin asked for it to be editable without a deploy, so it is now one
   * admin-only row in `payment_detail`, a form on /system, and four columns
   * copied onto each document at issue so an invoice keeps the account it was
   * issued with.
   *
   * Nothing replaces it here. A constant would be a second answer to "where
   * does a client pay", and the whole point of the table is that there is one.
   */
} as const;

/**
 * Where the app lives, for a link in an email.
 *
 * One answer, in one place. It was written out twice — once in
 * `notification-mail.ts` and once in the welcome mail — and two copies of a
 * hostname is how an environment ends up emailing links to the wrong one.
 * The trailing slash is stripped so `${appUrl()}/documents` cannot become a
 * double slash, which some mail clients refuse to make a link of.
 */
export function appUrl(): string {
  return (process.env.APP_URL ?? 'https://visionxart.cloud').replace(/\/$/, '');
}

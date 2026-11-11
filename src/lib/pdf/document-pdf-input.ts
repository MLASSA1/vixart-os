import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/session';
import type { PdfInput } from './document-pdf';

/**
 * Loading a document for the printer — one definition for both doors.
 *
 * The staff route and the portal route print the same paper, and a second
 * copy of this mapping is how a client's PDF ends up missing the RIB the
 * staff one has. Each route decides WHO may ask; this decides WHAT is printed.
 *
 * The columns are named one by one rather than `d.*`: the client role is
 * granted only the columns printed on the document (0085), and `d.*` on its
 * connection is refused outright.
 *
 * Returns null when the row is not visible — which, on the client connection,
 * includes a draft and anybody else's document.
 */
export async function loadDocumentForPdf(tx: Tx, id: string): Promise<PdfInput | null> {
  const d = await tx.execute<Record<string, unknown>>(sql`
    SELECT d.doc_type, d.status, d.number, c.name AS fallback_name,
           d.client_name, d.client_legal_name, d.client_ice, d.client_if, d.client_rc,
           d.client_address, d.client_is_individual,
           d.subject, d.notes, d.payment_terms, d.payment_method,
           d.vat_rate_bp, d.vat_exemption_reason, d.withholding, d.withholding_rate_bp,
           d.issuer_bank_name, d.issuer_bank_rib, d.issuer_bank_iban, d.issuer_bank_swift,
           d.issue_date::text AS issue_date_s, d.due_date::text AS due_date_s,
           d.discount_centimes::text AS discount_s,
           d.total_excl_vat::text AS excl_s, d.total_vat::text AS vat_s,
           d.total_incl_vat::text AS incl_s, d.withheld::text AS withheld_s,
           d.net_to_collect::text AS net_s
      FROM document d JOIN company c ON c.id = d.company_id
     WHERE d.id = ${id}
  `);
  const doc = d.rows[0];
  if (!doc) return null;
  const preview = doc.status === 'brouillon';

  /*
   * The account to print.
   *
   * An issued document carries its own, frozen at issue (0081) — including
   * NULLs, for anything issued while the details were still blank, which is
   * faithful: that is what the paper said at the time. A draft has no
   * snapshot yet, so a preview shows the current row, which is what issuing
   * it today would stamp on. (A client never reaches a draft.)
   */
  const live = preview
    ? (await tx.execute<{ bank_name: string | null; rib: string | null;
                          iban: string | null; swift: string | null }>(sql`
        SELECT bank_name, rib, iban, swift FROM payment_detail LIMIT 1
      `)).rows[0] ?? null
    : null;

  const lines = await tx.execute<Record<string, unknown>>(sql`
    SELECT label, unit, unit_price_centimes::text AS price_s,
           quantity_millis::text AS qty_s
      FROM document_line WHERE document_id = ${id} ORDER BY position, created_at
  `);

  const s = (k: string) => (doc[k] as string | null) ?? null;
  return {
    docType: String(doc.doc_type),
    number: String(doc.number),
    issueDate: s('issue_date_s'),
    dueDate: s('due_date_s'),
    clientName: s('client_name') ?? String(doc.fallback_name),
    clientLegalName: s('client_legal_name'),
    clientIce: s('client_ice'),
    clientIf: s('client_if'),
    clientRc: s('client_rc'),
    preview,
    bank: preview
      ? {
          name: live?.bank_name ?? '',
          rib: live?.rib ?? '',
          iban: live?.iban ?? '',
          swift: live?.swift ?? '',
        }
      : {
          name: s('issuer_bank_name') ?? '',
          rib: s('issuer_bank_rib') ?? '',
          iban: s('issuer_bank_iban') ?? '',
          swift: s('issuer_bank_swift') ?? '',
        },
    clientAddress: s('client_address'),
    subject: s('subject'),
    notes: s('notes'),
    paymentTerms: s('payment_terms'),
    paymentMethod: s('payment_method'),
    clientIsIndividual: Boolean(doc.client_is_individual),
    vatRateBp: Number(doc.vat_rate_bp),
    vatExemptionReason: s('vat_exemption_reason'),
    withholding: Boolean(doc.withholding),
    withholdingRateBp: Number(doc.withholding_rate_bp),
    discountCentimes: BigInt(String(doc.discount_s)),
    totalExclVat: BigInt(String(doc.excl_s)),
    totalVat: BigInt(String(doc.vat_s)),
    totalInclVat: BigInt(String(doc.incl_s)),
    withheld: BigInt(String(doc.withheld_s)),
    netToCollect: BigInt(String(doc.net_s)),
    lines: lines.rows.map((l) => ({
      label: String(l.label),
      unit: String(l.unit),
      unitPriceCentimes: BigInt(String(l.price_s)),
      quantityMillis: BigInt(String(l.qty_s)),
    })),
  };
}

/** The response both routes send. */
export function pdfResponse(buffer: Buffer, input: PdfInput): Response {
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${input.preview ? 'brouillon' : input.number}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}

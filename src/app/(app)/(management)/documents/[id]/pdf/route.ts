import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { renderDocumentPdf } from '@/lib/pdf/document-pdf';

/**
 * Server-side A4 PDF.
 *
 * A DRAFT NOW PRINTS, watermarked. It used to be refused outright on the
 * reasoning that a draft has no number and no frozen figures, so a PDF of one
 * would claim to be something it is not — which was right about the risk and
 * wrong about the remedy. Amin needs to see the layout before issuing, because
 * issuing spends a document number for good and cannot be undone.
 *
 * So a draft renders with BROUILLON across every page, "sans numéro" where the
 * number goes, and the current payment details rather than a snapshot. An
 * issued document renders exactly as before, from the figures and the account
 * frozen onto it at issue.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (session?.user.role !== 'admin') {
    return new NextResponse('Not found', { status: 404 });
  }

  const data = await withUser(async (tx) => {
    const d = await tx.execute<Record<string, unknown>>(sql`
      SELECT d.*, c.name AS fallback_name,
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

    /*
     * The account to print.
     *
     * An issued document carries its own, frozen at issue (0081) — including
     * NULLs, for anything issued while the details were still blank, which is
     * faithful: that is what the paper said at the time. A draft has no
     * snapshot yet, so a preview shows the current row, which is what issuing
     * it today would stamp on.
     */
    const live = doc.status === 'brouillon'
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
    return { doc, lines: lines.rows, live };
  });

  if (!data) return new NextResponse('Not found', { status: 404 });
  const preview = data.doc.status === 'brouillon';

  const buffer = await renderDocumentPdf({
    docType: String(data.doc.doc_type),
    number: String(data.doc.number),
    issueDate: (data.doc.issue_date_s as string) ?? null,
    dueDate: (data.doc.due_date_s as string) ?? null,
    clientName: (data.doc.client_name as string) ?? String(data.doc.fallback_name),
    clientLegalName: (data.doc.client_legal_name as string) ?? null,
    clientIce: (data.doc.client_ice as string) ?? null,
    clientIf: (data.doc.client_if as string) ?? null,
    clientRc: (data.doc.client_rc as string) ?? null,
    preview,
    bank: preview
      ? {
          name: data.live?.bank_name ?? '',
          rib: data.live?.rib ?? '',
          iban: data.live?.iban ?? '',
          swift: data.live?.swift ?? '',
        }
      : {
          name: (data.doc.issuer_bank_name as string) ?? '',
          rib: (data.doc.issuer_bank_rib as string) ?? '',
          iban: (data.doc.issuer_bank_iban as string) ?? '',
          swift: (data.doc.issuer_bank_swift as string) ?? '',
        },
    clientAddress: (data.doc.client_address as string) ?? null,
    subject: (data.doc.subject as string) ?? null,
    notes: (data.doc.notes as string) ?? null,
    paymentTerms: (data.doc.payment_terms as string) ?? null,
    paymentMethod: (data.doc.payment_method as string) ?? null,
    clientIsIndividual: Boolean(data.doc.client_is_individual),
    vatRateBp: Number(data.doc.vat_rate_bp),
    vatExemptionReason: (data.doc.vat_exemption_reason as string) ?? null,
    withholding: Boolean(data.doc.withholding),
    withholdingRateBp: Number(data.doc.withholding_rate_bp),
    discountCentimes: BigInt(String(data.doc.discount_s)),
    totalExclVat: BigInt(String(data.doc.excl_s)),
    totalVat: BigInt(String(data.doc.vat_s)),
    totalInclVat: BigInt(String(data.doc.incl_s)),
    withheld: BigInt(String(data.doc.withheld_s)),
    netToCollect: BigInt(String(data.doc.net_s)),
    lines: data.lines.map((l) => ({
      label: String(l.label),
      unit: String(l.unit),
      unitPriceCentimes: BigInt(String(l.price_s)),
      quantityMillis: BigInt(String(l.qty_s)),
    })),
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${
        preview ? 'brouillon' : String(data.doc.number)
      }.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}

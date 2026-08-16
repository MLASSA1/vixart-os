import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { renderDocumentPdf } from '@/lib/pdf/document-pdf';

/**
 * Server-side A4 PDF. Only an issued document can be downloaded — a draft has
 * no number and no frozen figures, so a PDF of one would claim to be something
 * it is not.
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

    const lines = await tx.execute<Record<string, unknown>>(sql`
      SELECT label, unit, unit_price_centimes::text AS price_s,
             quantity_millis::text AS qty_s
        FROM document_line WHERE document_id = ${id} ORDER BY position, created_at
    `);
    return { doc, lines: lines.rows };
  });

  if (!data) return new NextResponse('Not found', { status: 404 });
  if (data.doc.status === 'brouillon') {
    return new NextResponse(
      'This document is still a draft. Issue it before downloading a PDF.',
      { status: 409 },
    );
  }

  const buffer = await renderDocumentPdf({
    docType: String(data.doc.doc_type),
    number: String(data.doc.number),
    issueDate: (data.doc.issue_date_s as string) ?? null,
    dueDate: (data.doc.due_date_s as string) ?? null,
    clientName: (data.doc.client_name as string) ?? String(data.doc.fallback_name),
    clientLegalName: (data.doc.client_legal_name as string) ?? null,
    clientIce: (data.doc.client_ice as string) ?? null,
    clientIf: (data.doc.client_if as string) ?? null,
    clientAddress: (data.doc.client_address as string) ?? null,
    subject: (data.doc.subject as string) ?? null,
    notes: (data.doc.notes as string) ?? null,
    paymentTerms: (data.doc.payment_terms as string) ?? null,
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
      'Content-Disposition': `inline; filename="${data.doc.number}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}

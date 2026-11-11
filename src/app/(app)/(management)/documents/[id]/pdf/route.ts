import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { renderDocumentPdf } from '@/lib/pdf/document-pdf';
import { loadDocumentForPdf, pdfResponse } from '@/lib/pdf/document-pdf-input';

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

  const input = await withUser((tx) => loadDocumentForPdf(tx, id));
  if (!input) return new NextResponse('Not found', { status: 404 });
  return pdfResponse(await renderDocumentPdf(input), input);
}

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withClient } from '@/db/session';
import { renderDocumentPdf } from '@/lib/pdf/document-pdf';
import { loadDocumentForPdf, pdfResponse } from '@/lib/pdf/document-pdf-input';

/**
 * A client's own invoice or quote, as the PDF we sent them.
 *
 * Read on the client connection, so the policies of 0085 decide: their own
 * company's issued documents and nothing else. A draft, a cancelled document
 * or somebody else's id all come back as the same 404 — a different answer
 * would tell a client which ids exist.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (session?.user.kind !== 'client' || session.user.mustChangePassword) {
    return new NextResponse('Not found', { status: 404 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });

  const input = await withClient(session.user.id, (tx) => loadDocumentForPdf(tx, id));
  if (!input) return new NextResponse('Not found', { status: 404 });
  return pdfResponse(await renderDocumentPdf(input), input);
}

import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { attachment } from '@/db/schema';
import { withUser } from '@/db/session';
import { resolveInsideRoot } from '@/lib/uploads';
import { parseRange } from '@/lib/http-range';

/**
 * Serves an attachment. Authenticated, and filtered by the same RLS policies as
 * the record it hangs off — a member asking for a file attached to an invoice
 * gets a 404, because the row is not visible to them.
 *
 * Files are never served from a public directory: the only way to the bytes is
 * through this route.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return new NextResponse('Not found', { status: 404 });

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const record = await withUser(async (tx) => {
    const rows = await tx
      .select()
      .from(attachment)
      .where(eq(attachment.id, id))
      .limit(1);
    return rows[0] ?? null;
  });

  // Either it does not exist, or RLS hid it. Same answer either way — a
  // different one would tell a member which invoices have attachments.
  if (!record) return new NextResponse('Not found', { status: 404 });

  let absolute: string;
  try {
    absolute = resolveInsideRoot(record.storedPath);
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }

  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    // The row survived but the file did not — a restore from a database dump
    // without the uploads volume, most likely. Say so rather than 500.
    return new NextResponse(
      'This file is missing from storage. Restore the uploads volume, or delete the attachment.',
      { status: 410 },
    );
  }

  // Immutable per id, so the id and the size identify the bytes completely.
  const tag = `"${record.id}-${size}"`;

  // Already held, and still allowed to hold it: no bytes need to move.
  if (request.headers.get('if-none-match') === tag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: tag, 'Cache-Control': 'private, max-age=86400, immutable' },
    });
  }

  // Common to every answer below.
  const headers: Record<string, string> = {
    'Content-Type': record.mimeType,
    // `attachment` for everything: an inline PDF or image from our own origin
    // is a needless risk, and the allowlist is not a substitute for it. It does
    // not stop an <audio> or <video> element playing the bytes, which is how a
    // voice note is heard.
    'Content-Disposition': `attachment; filename="${encodeURIComponent(record.originalName)}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    // WHY THIS IS CACHEABLE, AND WHY IT IS SAFE.
    //
    // It was `no-store`, which meant every photograph in a channel was
    // downloaded again on every page load, every scroll back, and every
    // reconnect — over mobile data in Agadir, repeatedly, for bytes the
    // browser already had. Nothing about an attachment changes: a new upload
    // is a new row with a new id, so the bytes behind one id are the same
    // bytes for ever. `immutable` says exactly that, and the browser stops
    // asking.
    //
    // `private` keeps it out of any shared cache, and the window is a day, so
    // a borrowed laptop is not carrying the agency's files around for a month.
    //
    // What this does NOT do is skip the permission check. The row is looked up
    // under this person's own policies above, and a 304 is only ever sent
    // after that has succeeded — a cache that answered before the check would
    // be a way to read a file after losing access to it.
    'Cache-Control': 'private, max-age=86400, immutable',
    // For the revalidation after that day: a 304 costs a request and no bytes.
    ETag: tag,
    // Advertised so a player knows it may skip. Without this the scrubber on a
    // voice note is decorative: play works and dragging does nothing, silently.
    'Accept-Ranges': 'bytes',
  };

  const wanted = parseRange(request.headers.get('range'), size);

  if (wanted.kind === 'unsatisfiable') {
    return new NextResponse(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }

  if (wanted.kind === 'range') {
    const { start, end } = wanted.range;
    const slice = Readable.toWeb(
      createReadStream(absolute, { start, end }),
    ) as ReadableStream;
    return new NextResponse(slice, {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream;
  return new NextResponse(stream, {
    headers: { ...headers, 'Content-Length': String(size) },
  });
}

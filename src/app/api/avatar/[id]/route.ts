import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';

/**
 * A person's picture, by the PERSON's id rather than the file's.
 *
 * WHY THIS EXISTS AT ALL, GIVEN /api/files/[id] SERVES ATTACHMENTS.
 *
 * Because a face is drawn in a dozen places — every message in a channel, every
 * row in the private list, the team page, a profile — and the alternative is
 * carrying an attachment id through every query that renders a person. Miss one
 * and that screen silently shows initials for ever, which looks like a design
 * choice rather than a bug. One url per person means the component needs only
 * what it already has.
 *
 * It REDIRECTS rather than streaming. There is exactly one piece of code in this
 * project that decides how a stored file is served — the disposition, the
 * sandbox and nosniff headers, the cache rule, the range handling — and a second
 * one written here would be the copy that drifts, and it would drift in the
 * headers. So this resolves who to which file and hands over.
 *
 * The 404 is cached deliberately. Most people will not have a picture for a
 * while, and without it every message in every channel would cost a request
 * that fails.
 */
export const dynamic = 'force-dynamic';

/** Five minutes: long enough to stop the storm, short enough that a new picture appears. */
const CACHE = 'private, max-age=300';

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

  // A banner is the same question about the same person.
  const wantsBanner = new URL(request.url).searchParams.get('banner') === '1';
  const kind = wantsBanner ? 'user_banner' : 'user_avatar';

  const fileId = await withUser(async (tx) => {
    const found = await tx.execute<{ id: string }>(sql`
      SELECT a.id::text AS id
        FROM attachment a
       WHERE a.entity_type = ${kind}
         AND a.entity_id = ${id}
    `);
    return found.rows[0]?.id ?? null;
  });

  if (!fileId) {
    return new NextResponse('Not found', {
      status: 404,
      headers: { 'Cache-Control': CACHE },
    });
  }

  /*
   * A RELATIVE Location, and this is not a style preference.
   *
   * `NextResponse.redirect` demands an absolute url, so the obvious version is
   * `new URL('/api/files/…', request.url)` — and behind nginx that resolved to
   * the container's own listen address. The header came back pointing at
   * http://0.0.0.0:3000, which is reachable from inside the container and from
   * nowhere else: every avatar in the application would have been a broken
   * image, and only in production.
   *
   * A relative reference is valid in a Location header and the browser resolves
   * it against the request it made, so the question of which host this is never
   * has to be answered here.
   */
  return new NextResponse(null, {
    status: 307,
    headers: { Location: `/api/files/${fileId}`, 'Cache-Control': CACHE },
  });
}

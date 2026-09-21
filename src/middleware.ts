import { NextResponse, type NextRequest } from 'next/server';

/**
 * One image, two applications, and neither can serve the other's pages.
 *
 * The portal and the internal system are the same build running in two
 * containers with different environments. That is deliberate — a second Next
 * project means a second node_modules and a second build on a box with one
 * core — but it means both sets of routes are compiled into both containers,
 * and the only thing that would otherwise separate them is which URL somebody
 * types.
 *
 * So this closes them off by mode. In the portal, everything that is not
 * `/portal` or the auth endpoints is Not Found; in the internal application,
 * `/portal` is Not Found.
 *
 * IT IS NOT THE BOUNDARY. The boundary is that the portal container holds only
 * the client role's connection string, which has SELECT on six tables and no
 * default privileges (migration 0064) — so an internal page reached in the
 * portal could not read anything even if it rendered. This is the cheaper,
 * earlier layer: a 404 rather than a page that half-loads and throws.
 *
 * 404 rather than a redirect, because a redirect from /finance to /portal tells
 * an outsider that /finance is a page somewhere.
 */

const PORTAL_MODE = process.env.APP_MODE === 'portal';

/** Reachable in the portal. Everything else there is Not Found. */
function allowedInPortal(path: string): boolean {
  return (
    path === '/' ||
    path.startsWith('/portal') ||
    // Auth.js's own endpoints: sign-in, callback, session, csrf, sign-out.
    path.startsWith('/api/auth') ||
    path.startsWith('/_next') ||
    path.startsWith('/favicon') ||
    path === '/robots.txt'
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PORTAL_MODE) {
    if (pathname === '/') {
      return NextResponse.redirect(new URL('/portal', request.url));
    }
    if (!allowedInPortal(pathname)) {
      return new NextResponse('Not found', { status: 404 });
    }
    return NextResponse.next();
  }

  // The internal application. The portal's pages are not part of it.
  if (pathname === '/portal' || pathname.startsWith('/portal/')) {
    return new NextResponse('Not found', { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  /*
   * Everything except Next's own static output. Matching the static files too
   * would run this on every chunk of every page for no benefit, and on one
   * core that is not free.
   */
  matcher: ['/((?!_next/static|_next/image).*)'],
};

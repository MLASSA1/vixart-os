'use client';

import Link from 'next/link';

/**
 * The portal's own error screen.
 *
 * Next's default is "Application error: a client-side exception has occurred"
 * — which is what a client saw when a page threw instead of redirecting. Even
 * with that fixed, the next unexpected thing should land somewhere that looks
 * like VIXART and tells them what to do, rather than somewhere that looks
 * like the site is broken.
 *
 * Deliberately says nothing about what went wrong: the reader is a client, and
 * the detail is in the server logs where it is useful.
 */
export default function PortalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-[100dvh] flex-col justify-center px-6 py-16">
      <div className="mx-auto w-full max-w-[440px]">
        <p className="vix-wordmark text-2xl">VIXART</p>

        <div className="vix-card mt-10 px-7 py-8">
          <h1 className="vix-h2">That did not load.</h1>
          <p className="vix-body mt-3">
            Something went wrong at our end. Try again, and if it keeps
            happening tell us at admin@visionxart.com — we would rather know.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <button type="button" onClick={reset} className="vix-btn">
              Try again
            </button>
            <Link href="/portal/sign-in" className="vix-btn vix-btn-quiet">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

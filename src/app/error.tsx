'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * The common case in practice is a stale tab: Server Action IDs are hashed per
 * build, so a page rendered before a deploy posts an ID the new server does not
 * recognise. Next.js would otherwise show a raw "a client-side exception has
 * occurred", which tells nobody what to do. Reloading fixes it, so say that.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[vixart]', error);
  }, [error]);

  const staleDeployment =
    error.message.includes('Server Action') ||
    error.message.includes('deployment') ||
    error.message.includes('Connection closed');

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="border-b-2 border-void pb-5">
        <p className="label" style={{ opacity: 0.52 }}>
          VIXART OS
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          {staleDeployment ? 'This page is out of date' : 'Something went wrong'}
        </h1>
      </header>

      <p className="prose-vixart mt-6" style={{ opacity: 0.68 }}>
        {staleDeployment
          ? 'The application was updated while this tab was open, so this page no longer matches the server. Reload it and carry on — nothing was lost, and nothing was saved from this attempt.'
          : 'The action could not be completed. Nothing was saved. Try again, and if it keeps happening send Amin the reference below.'}
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Reload the page
        </button>
        <button type="button" className="btn btn-inverse" onClick={reset}>
          Try again
        </button>
      </div>

      {error.digest && (
        <p className="label mt-10 border-t border-void/10 pt-5" style={{ opacity: 0.52 }}>
          Reference {error.digest}
        </p>
      )}
    </main>
  );
}

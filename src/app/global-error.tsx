'use client';

/**
 * Last-resort boundary: catches failures in the root layout itself, where the
 * normal error boundary cannot render. It replaces <html> entirely, so it
 * cannot rely on the app's fonts or stylesheet — the styles here are inline on
 * purpose, and kept to the two brand colours.
 *
 * Night studio (Nov 2026): the same two colours, the other way round. A crash
 * page that flashed white in a dark application would read as a different
 * system having taken over — exactly the wrong signal when nothing is lost.
 * Values are copied from globals.css by hand, since that file is the thing
 * that may not have loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          backgroundColor: '#121110',
          color: '#F4F1EA',
          colorScheme: 'dark',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 15,
          lineHeight: 1.55,
          margin: 0,
          padding: '4rem 1.5rem',
        }}
      >
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          <p
            style={{
              fontFamily: 'monospace',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              opacity: 0.52,
              margin: 0,
            }}
          >
            VIXART OS
          </p>
          <h1
            style={{
              fontSize: '1.875rem',
              fontWeight: 700,
              margin: '0.5rem 0 1.25rem',
              paddingBottom: '1.25rem',
              borderBottom: '2px solid #F4F1EA',
            }}
          >
            The application failed to start
          </h1>

          <p style={{ opacity: 0.68, maxWidth: '68ch' }}>
            No data was lost — everything lives in the database, untouched by
            this. Reload the page. If it keeps failing, the server logs will say
            why: <code>docker compose logs app</code>
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '2rem',
              fontFamily: 'monospace',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontSize: 15,
              padding: '0.625rem 1.125rem',
              border: '1px solid #7C3AED',
              backgroundColor: '#7C3AED',
              color: '#FFFFFF',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>

          {error.digest && (
            <p
              style={{
                fontFamily: 'monospace',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                opacity: 0.52,
                marginTop: '2.5rem',
                paddingTop: '1.25rem',
                borderTop: '1px solid rgba(244,241,234,0.12)',
              }}
            >
              Reference {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/**
 * The three faces, served from this repository rather than fetched at build.
 *
 * They used to come through next/font/google, which downloads them while the
 * image is being built. That worked until the build machine could not reach
 * Google — and then the whole thing failed on a font, with the application
 * itself perfectly fine. For a system whose entire premise is that it runs on
 * a machine VIXART controls, a build that phones out to Mountain View is a
 * dependency nobody agreed to.
 *
 * 352 KB of woff2 in src/app/fonts, latin and latin-ext, exactly the weights
 * used. The build now needs no network at all.
 *
 * Inter carries the interface. Space Grotesk takes headings and big figures.
 * IBM Plex Mono is kept for what it is good at: figures that must line up in a
 * column, and codes that get copied — ICE, tax IDs, document numbers.
 */
const inter = localFont({
  src: [
    { path: './fonts/inter-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/inter-500-latin.woff2', weight: '500', style: 'normal' },
    { path: './fonts/inter-600-latin.woff2', weight: '600', style: 'normal' },
    { path: './fonts/inter-700-latin.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-interface',
  display: 'block',
});

const grotesk = localFont({
  src: [
    { path: './fonts/grotesk-500-latin.woff2', weight: '500', style: 'normal' },
    { path: './fonts/grotesk-600-latin.woff2', weight: '600', style: 'normal' },
    { path: './fonts/grotesk-700-latin.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'block',
});

/*
 * The wordmark, and only the wordmark.
 *
 * VIXART's own brand face, taken from visionxart.com where it is self-hosted.
 * It is used for one word on one surface — the logotype in the client portal's
 * header — because the portal is the half of this system clients look at, and
 * it should look like the company they hired. The internal application keeps
 * Space Grotesk: nobody outside the team ever sees it.
 *
 * Nine kilobytes: it covers the letters of the name and little else.
 */
const wordmark = localFont({
  src: [{ path: './fonts/vixart-wordmark.otf', weight: '700', style: 'normal' }],
  variable: '--font-wordmark',
  display: 'block',
});

const plexMono = localFont({
  src: [{ path: './fonts/plexmono-500-latin.woff2', weight: '500', style: 'normal' }],
  variable: '--font-figures',
  display: 'block',
});

export const metadata: Metadata = {
  title: 'VIXART OS',
  description: 'Internal operating system — SOCIETE VIXART SARL',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable} ${grotesk.variable} ${wordmark.variable}`}>
      <body>{children}</body>
    </html>
  );
}

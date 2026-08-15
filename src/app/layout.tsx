import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';

/**
 * Three typographic roles, two typefaces. The VIX ART display face appears
 * nowhere in this application: it is a brand signature, not an interface face.
 *
 * `display: 'block'` rather than `swap`: a brief blank is preferable to a
 * visible swap from a system fallback. No substitution.
 */
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-interface',
  display: 'block',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['500'],
  variable: '--font-metadata',
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
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

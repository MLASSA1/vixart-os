import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';

/**
 * Inter carries the whole interface. IBM Plex Mono is kept only for figures
 * that must align in a column and codes that get copied — not for labels,
 * buttons or headings, which read badly in uppercase mono.
 *
 * The VIX ART display face appears nowhere here: it is a brand signature, not
 * an interface face.
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
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';

/**
 * Trois rôles typographiques, deux polices. La police d'affichage VIX ART
 * n'apparaît nulle part dans cette application : c'est une signature de marque,
 * pas une police d'interface.
 *
 * `display: 'block'` plutôt que `swap` : on préfère un bref vide au remplacement
 * visible par une police système. Aucune substitution.
 */
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700'],
  variable: '--police-interface',
  display: 'block',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['500'],
  variable: '--police-mono',
  display: 'block',
});

export const metadata: Metadata = {
  title: 'VIXART OS',
  description: "Système d'exploitation interne — SOCIETE VIXART SARL",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className={`${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

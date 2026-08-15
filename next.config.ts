import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Sortie autonome : le conteneur applicatif embarque son propre serveur Node,
  // sans dépendre de node_modules à l'exécution.
  output: 'standalone',

  // `pg` est un module natif côté serveur : il ne doit jamais être bundlé.
  serverExternalPackages: ['pg'],

  typescript: {
    // Le build échoue sur la moindre erreur de type. Pas de contournement.
    ignoreBuildErrors: false,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Sortie autonome : le conteneur applicatif embarque son propre serveur Node,
  // sans dépendre de node_modules à l'exécution.
  output: 'standalone',

  // `pg` est un module natif côté serveur : il ne doit jamais être bundlé.
  serverExternalPackages: ['pg'],

  experimental: {
    // Une pièce jointe part dans une Server Action, et Next plafonne le corps
    // d'une Server Action à 1 Mo tant que cette valeur n'est pas posée.
    //
    // Tout le reste du système est réglé sur 25 Mo : MAX_UPLOAD_BYTES, le CHECK
    // en base, le contrôle côté navigateur, le « La limite est 25 Mo » de
    // storeUpload, et le `client_max_body_size 26m` de nginx. Cette ligne-là
    // manquait — donc n'importe quelle photo de téléphone était refusée par le
    // framework, avec un 413 levé AVANT l'entrée dans l'action. Rien du parcours
    // écrit pour l'utilisateur ne pouvait s'exécuter : ni le message de refus
    // lisible, ni le « Message envoyé, mais pas le fichier ». L'écran « Une
    // erreur est survenue » et sa référence prenaient toute la place — sur les
    // cinq surfaces qui acceptent un fichier : chat, prep, projets, documents,
    // sociétés. Le portail client n'en a pas encore ; il hérite de ce réglage
    // le jour où il en aura une.
    //
    // Calé sur nginx (deploy/visionxart.cloud.conf) : les deux laissent passer
    // exactement la même chose, et le refus à 25 Mo revient à storeUpload, qui
    // sait l'expliquer.
    serverActions: { bodySizeLimit: '26mb' },

    // Et un SECOND plafond, sous le premier. `src/middleware.ts` existe, donc
    // toute requête traverse le middleware, où Next ne lit que les 10 premiers
    // Mo du corps par défaut. Au-delà, il ne refuse pas : il TRONQUE, et le
    // multipart ampute arrive à l'action en « Unexpected end of form ».
    //
    // Deux échecs différents pour un seul geste, donc — une pièce jointe entre
    // 1 et 10 Mo tombait sur bodySizeLimit, au-dessus de 10 Mo sur celui-ci.
    // Ne relever que le premier laissait la photo de 12 Mo échouer exactement
    // comme avant, avec une autre référence. Trouvé de cette façon : après le
    // premier correctif, un vrai JPEG de 11,8 Mo — la taille qu'un téléphone
    // produit — a échoué à nouveau.
    //
    // Même valeur que le reste de la chaîne : la limite qui compte est celle
    // de storeUpload, à 25 Mo, parce que c'est la seule qui sache le dire.
    middlewareClientMaxBodySize: '26mb',
  },

  typescript: {
    // Le build échoue sur la moindre erreur de type. Pas de contournement.
    ignoreBuildErrors: false,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;

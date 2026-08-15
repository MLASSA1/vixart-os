import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit ne sert QU'À GÉNÉRER des fichiers SQL numérotés dans `drizzle/`.
 *
 * ⚠️  Ne jamais lancer `drizzle-kit push` sur une base contenant des données
 *     réelles : cette commande altère le schéma sans passer par un fichier de
 *     migration versionné et peut détruire des colonnes. Le seul chemin autorisé
 *     est : `npm run db:generate` → relire le SQL → `npm run db:migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});

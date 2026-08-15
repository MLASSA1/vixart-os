import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is used ONLY to GENERATE numbered SQL files into `drizzle/`.
 *
 * ⚠️  Never run `drizzle-kit push` against a database holding real records: it
 *     alters the schema without a versioned migration file and can drop
 *     columns. The only allowed path is:
 *     `npm run db:generate` → read the SQL → `npm run db:migrate`.
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

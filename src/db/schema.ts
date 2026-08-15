/**
 * VIXART OS — schéma de base de données.
 *
 * Ce fichier est la source de vérité pour `drizzle-kit generate`, qui produit
 * les fichiers SQL numérotés de `drizzle/`. Les contraintes réellement
 * critiques (numérotation séquentielle, immuabilité des documents émis, RLS)
 * sont écrites à la main dans des migrations SQL dédiées : elles doivent vivre
 * dans PostgreSQL, pas dans le code applicatif.
 *
 * Convention monétaire : tout montant est un BIGINT de centimes, lu en `bigint`
 * JavaScript. Jamais de numeric, jamais de float. Voir src/lib/money.ts.
 */

import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Énumérations
// ---------------------------------------------------------------------------

/** Deux rôles, pas trois. Amin est admin, l'équipe est member. */
export const userRole = pgEnum('user_role', ['admin', 'member']);

/** Pipeline commercial : lead → prospect → client → dormant. */
export const clientStatus = pgEnum('client_status', [
  'lead',
  'prospect',
  'client',
  'dormant',
]);

// ---------------------------------------------------------------------------
// Équipe — les cinq seuls comptes du système. Pas d'inscription publique.
// ---------------------------------------------------------------------------

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    /** Intitulé de poste affiché (« Cinematic Director »). */
    jobTitle: text('job_title'),
    role: userRole('role').notNull().default('member'),
    /** Hash bcrypt. Le mot de passe en clair n'existe nulle part. */
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('app_user_email_key').on(sql`lower(${t.email})`)],
);

// ---------------------------------------------------------------------------
// CRM — une fiche par société. Mono-organisation : pas de colonne tenant_id.
// ---------------------------------------------------------------------------

export const client = pgTable(
  'client',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Nom d'usage : « Laboratoire Talborjt ». */
    name: text('name').notNull(),
    /** Raison sociale complète si elle diffère du nom d'usage. */
    legalName: text('legal_name'),
    status: clientStatus('status').notNull().default('lead'),

    // --- Identifiants légaux marocains, reportés sur chaque document émis ---
    ice: text('ice'),
    identifiantFiscal: text('identifiant_fiscal'),
    registreCommerce: text('registre_commerce'),

    addressLine: text('address_line'),
    city: text('city'),
    website: text('website'),

    /**
     * Le client applique-t-il la retenue à la source sur la TVA
     * (art. 117 bis CGI) ? Détermine l'affichage du « Net à encaisser ».
     */
    retenueSource: boolean('retenue_source').notNull().default(false),

    /** Résumé libre de la mission en cours, visible sur le tableau de bord. */
    engagementSummary: text('engagement_summary'),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('client_name_key').on(sql`lower(${t.name})`),
    index('client_status_idx').on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Paramètres fiscaux versionnés — jamais modifiés, seulement complétés.
// ---------------------------------------------------------------------------

export const fiscalRate = pgTable(
  'fiscal_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `tva_standard`, `retenue_source_tva`. Voir src/lib/fiscal.ts. */
    key: text('key').notNull(),
    /** Taux en points de base : 2000 = 20 %. Entier, jamais un flottant. */
    rateBp: integer('rate_bp').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('fiscal_rate_key_from_key').on(t.key, t.effectiveFrom)],
);

// ---------------------------------------------------------------------------
// Types applicatifs
// ---------------------------------------------------------------------------

export type AppUser = typeof appUser.$inferSelect;
export type NewAppUser = typeof appUser.$inferInsert;
export type Client = typeof client.$inferSelect;
export type NewClient = typeof client.$inferInsert;
export type FiscalRate = typeof fiscalRate.$inferSelect;

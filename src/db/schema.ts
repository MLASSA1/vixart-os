/**
 * VIXART OS — database schema.
 *
 * This file is the source of truth for `drizzle-kit generate`, which produces
 * the numbered SQL files in `drizzle/`. The genuinely critical constraints
 * (gapless numbering, immutability of issued documents, RLS) are hand-written
 * in dedicated SQL migrations: they must live in PostgreSQL, not in
 * application code.
 *
 * Money convention: every amount is a BIGINT of centimes, read as a JavaScript
 * `bigint`. Never numeric, never float. See src/lib/money.ts.
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

/** Two roles, not three. Amin is admin, the team are members. */
export const userRole = pgEnum('user_role', ['admin', 'member']);

/** Sales pipeline: lead → prospect → client → dormant. */
export const clientStatus = pgEnum('client_status', [
  'lead',
  'prospect',
  'client',
  'dormant',
]);

/** Nature of a touchpoint recorded on a client's timeline. */
export const interactionKind = pgEnum('interaction_kind', [
  'note',
  'reunion',
  'appel',
  'whatsapp',
  'email',
  'proposition',
]);

// ---------------------------------------------------------------------------
// Team — the only five accounts in the system. No public sign-up.
// ---------------------------------------------------------------------------

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    /** Displayed job title ("Cinematic Director"). */
    jobTitle: text('job_title'),
    role: userRole('role').notNull().default('member'),
    /** bcrypt hash. The plaintext password exists nowhere. */
    passwordHash: text('password_hash').notNull(),
    /**
     * Seeded accounts share one initial password: each member must change it
     * before reaching the rest of the application.
     */
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('app_user_email_key').on(sql`lower(${t.email})`)],
);

// ---------------------------------------------------------------------------
// CRM — one record per company. Single-org: no tenant_id column.
// ---------------------------------------------------------------------------

export const client = pgTable(
  'client',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Trading name: "Laboratoire Talborjt". */
    name: text('name').notNull(),
    /** Full registered name when it differs from the trading name. */
    legalName: text('legal_name'),
    status: clientStatus('status').notNull().default('lead'),

    // --- Moroccan legal identifiers, carried onto every issued document ---
    ice: text('ice'),
    identifiantFiscal: text('identifiant_fiscal'),
    registreCommerce: text('registre_commerce'),

    addressLine: text('address_line'),
    city: text('city'),
    website: text('website'),

    /**
     * Does this client withhold VAT at source (art. 117 bis CGI)?
     * Drives whether "Net to collect" is shown.
     */
    retenueSource: boolean('retenue_source').notNull().default(false),

    /** Free-text summary of the current engagement, shown on the dashboard. */
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
// Contacts — the people behind the company.
// ---------------------------------------------------------------------------

export const contact = pgTable(
  'contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => client.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    /** Role in the company: "Managing director", "Head of marketing". */
    roleTitle: text('role_title'),
    email: text('email'),
    phone: text('phone'),
    /** WhatsApp number — the agency's primary channel. */
    whatsapp: text('whatsapp'),
    /** Primary contact: at most one per client, enforced by a partial index. */
    isPrimary: boolean('is_primary').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contact_client_idx').on(t.clientId),
    uniqueIndex('contact_unique_primary')
      .on(t.clientId)
      .where(sql`${t.isPrimary}`),
  ],
);

// ---------------------------------------------------------------------------
// Timeline — the memory of the relationship. Replaces WhatsApp as source of truth.
// ---------------------------------------------------------------------------

export const interaction = pgTable(
  'interaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => client.id, { onDelete: 'cascade' }),
    /** Who recorded it. Kept even if the account is deleted later. */
    authorId: uuid('author_id').references(() => appUser.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    kind: interactionKind('kind').notNull().default('note'),
    /** When the exchange happened, distinct from when it was typed in. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    title: text('title').notNull(),
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('interaction_client_date_idx').on(t.clientId, t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// Versioned tax parameters — never edited, only appended to.
// ---------------------------------------------------------------------------

export const fiscalRate = pgTable(
  'fiscal_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `tva_standard`, `retenue_source_tva`. See src/lib/fiscal.ts. */
    key: text('key').notNull(),
    /** Rate in basis points: 2000 = 20%. Integer, never a float. */
    rateBp: integer('rate_bp').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('fiscal_rate_key_from_key').on(t.key, t.effectiveFrom)],
);

// ---------------------------------------------------------------------------
// Application types
// ---------------------------------------------------------------------------

export type AppUser = typeof appUser.$inferSelect;
export type NewAppUser = typeof appUser.$inferInsert;
export type Client = typeof client.$inferSelect;
export type NewClient = typeof client.$inferInsert;
export type Contact = typeof contact.$inferSelect;
export type NewContact = typeof contact.$inferInsert;
export type Interaction = typeof interaction.$inferSelect;
export type NewInteraction = typeof interaction.$inferInsert;
export type FiscalRate = typeof fiscalRate.$inferSelect;


/**
 * Interaction kinds. The stored values stay as they are in the database enum —
 * renaming an enum value would mean a migration and would break existing rows —
 * only the displayed labels are English.
 */
export const INTERACTION_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'reunion', label: 'Meeting' },
  { value: 'appel', label: 'Call' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'proposition', label: 'Proposal' },
] as const;

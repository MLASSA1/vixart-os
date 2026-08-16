/**
 * VIXART OS — database schema.
 *
 * Source of truth for `drizzle-kit generate`, which produces the numbered SQL
 * files in `drizzle/`. The genuinely critical rules (gapless numbering,
 * immutability of issued documents, RLS, the two-step task sign-off) are
 * hand-written in dedicated SQL migrations: they must live in PostgreSQL, not
 * in application code.
 *
 * Money convention: every amount is a BIGINT of centimes, read as a JavaScript
 * `bigint`. Never numeric, never float. See src/lib/money.ts.
 */

import {
  bigint,
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
// Enumerations
//
// `role`, `stage`, `status` and `priority` on the newer tables are text + CHECK
// rather than PostgreSQL enums. Extending a real enum (ALTER TYPE ... ADD
// VALUE) cannot be used in the same transaction that adds it, and the migrator
// runs every pending migration in one transaction. Text + CHECK gives the same
// guarantee without that trap.
// ---------------------------------------------------------------------------

/** Where an organisation sits in the sales pipeline. */
export const companyStage = pgEnum('client_status', [
  'lead',
  'prospect',
  'client',
  'dormant',
]);

/** Nature of a touchpoint recorded on a company timeline. */
export const interactionKind = pgEnum('interaction_kind', [
  'note',
  'reunion',
  'appel',
  'whatsapp',
  'email',
  'proposition',
]);

/** Three roles. Amin is admin, Mohamed Amine moderates the work, rest are members. */
export const ROLES = ['admin', 'moderator', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** What an organisation is to VIXART. Independent of the pipeline stage. */
export const RELATIONSHIPS = ['client', 'supplier', 'partner', 'other'] as const;

/** An opportunity's life: proposal -> negotiation -> won / lost. */
export const DEAL_STAGES = ['proposal', 'negotiation', 'won', 'lost'] as const;

export const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'delivered'] as const;

/**
 * Task lifecycle. `submitted` is the member saying "I am done"; only a
 * moderator or admin can move it to `completed`. That two-step is enforced by
 * a trigger, not by hiding a button.
 */
export const TASK_STATUSES = ['todo', 'in_progress', 'submitted', 'completed'] as const;

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

// ---------------------------------------------------------------------------
// Team — the only accounts in the system. No public sign-up.
// ---------------------------------------------------------------------------

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    jobTitle: text('job_title'),
    /** 'admin' | 'moderator' | 'member' — text + CHECK, see note above. */
    role: text('role').notNull().default('member'),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('app_user_email_key').on(sql`lower(${t.email})`)],
);

// ---------------------------------------------------------------------------
// Companies — every organisation VIXART deals with.
//
// One table, three views: Companies (all), Clients (paying), Leads (not won).
// `relationship` says what they are; `status` says where they are.
// ---------------------------------------------------------------------------

export const company = pgTable(
  'company',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    /** 'client' | 'supplier' | 'partner' | 'other'. */
    relationship: text('relationship').notNull().default('client'),
    status: companyStage('status').notNull().default('lead'),

    // --- Moroccan legal identifiers, carried onto every issued document ---
    ice: text('ice'),
    identifiantFiscal: text('identifiant_fiscal'),
    registreCommerce: text('registre_commerce'),

    addressLine: text('address_line'),
    city: text('city'),
    website: text('website'),

    /** Withholds VAT at source (art. 117 bis CGI). */
    retenueSource: boolean('retenue_source').notNull().default(false),

    /** Agreed budget in centimes, from the Client Management module. */
    budgetCentimes: bigint('budget_centimes', { mode: 'bigint' }).notNull().default(sql`0`),
    engagementSummary: text('engagement_summary'),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('company_name_key').on(sql`lower(${t.name})`),
    index('company_status_idx').on(t.status),
    index('company_relationship_idx').on(t.relationship),
  ],
);

// ---------------------------------------------------------------------------
// Contacts — the people behind the organisation. The email/phone directory.
// ---------------------------------------------------------------------------

export const contact = pgTable(
  'contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    roleTitle: text('role_title'),
    email: text('email'),
    phone: text('phone'),
    whatsapp: text('whatsapp'),
    isPrimary: boolean('is_primary').notNull().default(false),
    /** Excluded from marketing exports. Consent, not a preference. */
    optedOut: boolean('opted_out').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contact_company_idx').on(t.companyId),
    uniqueIndex('contact_unique_primary')
      .on(t.companyId)
      .where(sql`${t.isPrimary}`),
  ],
);

// ---------------------------------------------------------------------------
// Timeline — the memory of the relationship. Replaces WhatsApp as the record.
// ---------------------------------------------------------------------------

export const interaction = pgTable(
  'interaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => appUser.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    kind: interactionKind('kind').notNull().default('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    title: text('title').notNull(),
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('interaction_company_date_idx').on(t.companyId, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// Deals — an opportunity with a value. Won deals become quotes, then invoices.
// ---------------------------------------------------------------------------

export const deal = pgTable(
  'deal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    /** Estimated value in centimes. Never a float. */
    // `sql\`0\`` rather than `0n`: drizzle-kit cannot serialise a BigInt literal
    // into its snapshot, and the column must stay a true BIGINT of centimes.
    valueCentimes: bigint('value_centimes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** 'proposal' | 'negotiation' | 'won' | 'lost'. */
    stage: text('stage').notNull().default('proposal'),
    /** 0-100. Used for the weighted pipeline forecast. */
    probability: integer('probability').notNull().default(50),
    expectedCloseDate: date('expected_close_date'),
    ownerId: uuid('owner_id').references(() => appUser.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * Discount as a fixed amount in centimes, taken off the total before VAT.
     * A money figure, not a percentage — that is how it is agreed and how it
     * prints on the document.
     */
    discountCentimes: bigint('discount_centimes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Why a lost deal was lost. The most useful field in the table. */
    lostReason: text('lost_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('deal_company_idx').on(t.companyId), index('deal_stage_idx').on(t.stage)],
);

// ---------------------------------------------------------------------------
// Deal lines — the services on a deal.
//
// Every line is a SNAPSHOT. The service name, its unit and its price are copied
// onto the line when it is added, so raising a price in the catalog next month
// never silently moves the value of a deal already agreed. The link back to
// `service` is kept for reporting only, and is allowed to go null.
// ---------------------------------------------------------------------------

export const dealLine = pgTable(
  'deal_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deal.id, { onDelete: 'cascade' }),
    /** Reporting link only — the figures come from the snapshot columns. */
    serviceId: uuid('service_id').references(() => service.id, { onDelete: 'set null' }),
    /** Service name as it was when the line was added. */
    label: text('label').notNull(),
    /** 'forfait' | 'mois' | 'jour', as it was when the line was added. */
    unit: text('unit').notNull().default('forfait'),
    /** Unit price in centimes, frozen at the moment the line was added. */
    unitPriceCentimes: bigint('unit_price_centimes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Quantity in thousandths, so 1,5 days is exact. */
    quantityMillis: bigint('quantity_millis', { mode: 'bigint' })
      .notNull()
      .default(sql`1000`),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('deal_line_deal_idx').on(t.dealId, t.position)],
);

// ---------------------------------------------------------------------------
// Projects — the delivery side of a won deal.
// ---------------------------------------------------------------------------

export const project = pgTable(
  'project',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    /** The deal this delivers, when there is one. */
    dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description'),
    /** 'planned' | 'active' | 'on_hold' | 'delivered'. */
    status: text('status').notNull().default('planned'),
    /** 'branding' | 'website' | 'ads_campaign' | 'video' | 'other'. */
    projectType: text('project_type').notNull().default('branding'),
    startDate: date('start_date'),
    dueDate: date('due_date'),
    leadId: uuid('lead_id').references(() => appUser.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_company_idx').on(t.companyId),
    index('project_status_idx').on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Tasks — assigned work, with a two-step sign-off.
//
// A member moves their task to `submitted`. Only a moderator or admin can move
// it to `completed`. Enforced by a trigger so it holds regardless of the UI.
// ---------------------------------------------------------------------------

export const task = pgTable(
  'task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    assigneeId: uuid('assignee_id').references(() => appUser.id, { onDelete: 'set null' }),
    /** 'todo' | 'in_progress' | 'submitted' | 'completed'. */
    status: text('status').notNull().default('todo'),
    /** 'low' | 'normal' | 'high' | 'urgent'. */
    priority: text('priority').notNull().default('normal'),
    dueDate: date('due_date'),

    createdById: uuid('created_by_id').references(() => appUser.id, { onDelete: 'set null' }),
    /** When the assignee said it was done. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** When a moderator confirmed it. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedById: uuid('completed_by_id').references(() => appUser.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('task_project_idx').on(t.projectId),
    index('task_assignee_status_idx').on(t.assigneeId, t.status),
    index('task_due_idx').on(t.dueDate),
  ],
);

// ---------------------------------------------------------------------------
// Services — what VIXART sells, and what it costs.
//
// Price is NOT a column on the service. It lives in `service_price`, one row
// per version with an `effective_from` date, and those rows are immutable.
// Changing a price must never rewrite what an already-issued document said.
// ---------------------------------------------------------------------------

/** The seven service pillars. Stored as text + CHECK, see the note above. */
export const PILLARS = [
  'brand_architecture',
  'cinematic_production',
  'digital_presence',
  'social_media',
  'growth_marketing',
  'app_automation',
  'codex_ai',
] as const;

/** How a service is billed. */
export const SERVICE_UNITS = ['forfait', 'mois', 'jour'] as const;

export const service = pgTable(
  'service',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** One of PILLARS. */
    pillar: text('pillar').notNull(),
    /** 'forfait' (fixed fee) | 'mois' (per month) | 'jour' (per day). */
    unit: text('unit').notNull().default('forfait'),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('service_name_key').on(sql`lower(${t.name})`),
    index('service_pillar_idx').on(t.pillar),
  ],
);

/**
 * A dated price. Append-only: a trigger refuses UPDATE and DELETE, exactly like
 * `fiscal_rate`. Raising a price inserts a new row; last month's quote keeps
 * the figure it was issued with.
 */
export const servicePrice = pgTable(
  'service_price',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'cascade' }),
    /** Unit price in centimes, excluding VAT. Never a float. */
    unitPriceCentimes: bigint('unit_price_centimes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    effectiveFrom: date('effective_from').notNull(),
    note: text('note'),
    createdById: uuid('created_by_id').references(() => appUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('service_price_version_key').on(t.serviceId, t.effectiveFrom),
    index('service_price_service_idx').on(t.serviceId),
  ],
);

// ---------------------------------------------------------------------------
// Activity — written by database triggers, append-only.
// ---------------------------------------------------------------------------

export const activity = pgTable('activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').references(() => appUser.id, { onDelete: 'set null' }),
  actorName: text('actor_name').notNull().default('system'),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  entityLabel: text('entity_label'),
  action: text('action').notNull(),
  detail: text('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Comments — the internal thread on a project, task or client.
// ---------------------------------------------------------------------------

export const comment = pgTable(
  'comment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'project' | 'task' | 'company'. */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    authorId: uuid('author_id').references(() => appUser.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comment_entity_idx').on(t.entityType, t.entityId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Documents — quotes, invoices, credit notes.
//
// The rules that matter live in SQL (drizzle/0015): gapless numbering under a
// row lock, immutability after issue, snapshotted client identity and lines.
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = ['devis', 'facture', 'avoir'] as const;
export const DOCUMENT_STATUSES = ['brouillon', 'emis', 'paye', 'annule'] as const;

export const document = pgTable('document', {
  id: uuid('id').primaryKey().defaultRandom(),
  docType: text('doc_type').notNull(),
  status: text('status').notNull().default('brouillon'),

  /** Null while a draft. Assigned at issue and never changed. */
  number: text('number'),
  numberYear: integer('number_year'),
  numberSeq: integer('number_seq'),

  companyId: uuid('company_id').notNull().references(() => company.id),
  dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'set null' }),

  issueDate: date('issue_date'),
  dueDate: date('due_date'),

  vatRateBp: integer('vat_rate_bp').notNull().default(2000),
  vatExemptionReason: text('vat_exemption_reason'),
  withholding: boolean('withholding').notNull().default(false),
  withholdingRateBp: integer('withholding_rate_bp').notNull().default(0),

  discountCentimes: bigint('discount_centimes', { mode: 'bigint' }).notNull().default(sql`0`),

  totalExclVat: bigint('total_excl_vat', { mode: 'bigint' }).notNull().default(sql`0`),
  totalVat: bigint('total_vat', { mode: 'bigint' }).notNull().default(sql`0`),
  totalInclVat: bigint('total_incl_vat', { mode: 'bigint' }).notNull().default(sql`0`),
  withheld: bigint('withheld', { mode: 'bigint' }).notNull().default(sql`0`),
  netToCollect: bigint('net_to_collect', { mode: 'bigint' }).notNull().default(sql`0`),

  clientName: text('client_name'),
  clientLegalName: text('client_legal_name'),
  clientIce: text('client_ice'),
  clientIf: text('client_if'),
  clientAddress: text('client_address'),

  subject: text('subject'),
  notes: text('notes'),
  paymentTerms: text('payment_terms'),
  correctsId: uuid('corrects_id'),

  paidAt: timestamp('paid_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdById: uuid('created_by_id').references(() => appUser.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentLine = pgTable(
  'document_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').notNull().references(() => document.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => service.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    description: text('description'),
    unit: text('unit').notNull().default('forfait'),
    unitPriceCentimes: bigint('unit_price_centimes', { mode: 'bigint' }).notNull().default(sql`0`),
    quantityMillis: bigint('quantity_millis', { mode: 'bigint' }).notNull().default(sql`1000`),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('document_line_doc_idx').on(t.documentId, t.position)],
);

// ---------------------------------------------------------------------------
// Finance — one ledger, both directions.
//
// `direction` carries the sign; the amount is always positive, so a sign error
// cannot quietly turn a cost into income. Revenue is posted by a trigger when
// an invoice is marked paid (drizzle/0016).
// ---------------------------------------------------------------------------

export const financeEntry = pgTable(
  'finance_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'income' | 'expense'. */
    direction: text('direction').notNull(),
    amountCentimes: bigint('amount_centimes', { mode: 'bigint' }).notNull(),
    /** VAT contained in the amount, for the accountant. */
    vatCentimes: bigint('vat_centimes', { mode: 'bigint' }).notNull().default(sql`0`),
    entryDate: date('entry_date').notNull(),
    category: text('category').notNull(),
    /** 'virement' | 'especes' | 'cheque' | 'carte' | 'autre'. */
    paymentMethod: text('payment_method').notNull().default('virement'),
    description: text('description'),
    companyId: uuid('company_id').references(() => company.id, { onDelete: 'set null' }),
    documentId: uuid('document_id').references(() => document.id),
    reference: text('reference'),
    /** true when written by the revenue trigger rather than typed by hand. */
    isAutomatic: boolean('is_automatic').notNull().default(false),
    recordedById: uuid('recorded_by_id').references(() => appUser.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('finance_date_idx').on(t.entryDate),
    index('finance_direction_idx').on(t.direction, t.entryDate),
  ],
);

// ---------------------------------------------------------------------------
// Versioned tax parameters — never edited, only appended to.
// ---------------------------------------------------------------------------

export const fiscalRate = pgTable(
  'fiscal_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
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
export type Company = typeof company.$inferSelect;
export type NewCompany = typeof company.$inferInsert;
export type Contact = typeof contact.$inferSelect;
export type Interaction = typeof interaction.$inferSelect;
export type Deal = typeof deal.$inferSelect;
export type DealLine = typeof dealLine.$inferSelect;
export type Project = typeof project.$inferSelect;
export type Task = typeof task.$inferSelect;
export type FiscalRate = typeof fiscalRate.$inferSelect;
export type Service = typeof service.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type Comment = typeof comment.$inferSelect;
export type VixDocument = typeof document.$inferSelect;
export type DocumentLine = typeof documentLine.$inferSelect;
export type FinanceEntry = typeof financeEntry.$inferSelect;
export type ServicePrice = typeof servicePrice.$inferSelect;

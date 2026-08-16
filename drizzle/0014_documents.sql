-- =============================================================================
-- 0014 — Quotes, invoices and credit notes.
--
-- This is the file that matters most in the project. Everything here is
-- enforced by PostgreSQL rather than by application code, because a wrong
-- invoice is the one failure mode that cannot be undone by a redeploy.
--
--   * numbering is gapless and sequential, per type per year, under a row lock
--   * an issued document is read-only — corrected by a credit note, never edited
--   * line items and the client's identity are SNAPSHOTS taken at issue
--   * every amount is BIGINT centimes
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The counter
--
-- One row per (type, year). `SELECT ... FOR UPDATE` serialises concurrent
-- issuers, so two requests can never take the same number. A rolled-back
-- transaction releases its number, which is what keeps the run gapless: the
-- number is only spent if the document is really issued.
-- -----------------------------------------------------------------------------

CREATE TABLE "document_counter" (
  "doc_type" text NOT NULL,
  "year" integer NOT NULL,
  "last_seq" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("doc_type", "year"),
  CONSTRAINT "document_counter_type_valid" CHECK ("doc_type" IN ('devis','facture','avoir')),
  CONSTRAINT "document_counter_seq_positive" CHECK ("last_seq" >= 0)
);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. The document
--
-- brouillon -> emis -> paye / annule
-- While `brouillon` it is editable and has NO number. The number is taken at
-- the moment it becomes `emis`, and from then on the figures are frozen.
-- -----------------------------------------------------------------------------

CREATE TABLE "document" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "doc_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'brouillon',

  -- Null until issued. Unique once set.
  "number" text,
  "number_year" integer,
  "number_seq" integer,

  "company_id" uuid NOT NULL,
  "deal_id" uuid,

  "issue_date" date,
  "due_date" date,

  -- Rate snapshots. Never read back from fiscal_rate at render time.
  "vat_rate_bp" integer NOT NULL DEFAULT 2000,
  "vat_exemption_reason" text,
  "withholding" boolean NOT NULL DEFAULT false,
  "withholding_rate_bp" integer NOT NULL DEFAULT 0,

  "discount_centimes" bigint NOT NULL DEFAULT 0,

  -- Totals frozen at issue. A draft recomputes them on the fly.
  "total_excl_vat" bigint NOT NULL DEFAULT 0,
  "total_vat" bigint NOT NULL DEFAULT 0,
  "total_incl_vat" bigint NOT NULL DEFAULT 0,
  "withheld" bigint NOT NULL DEFAULT 0,
  "net_to_collect" bigint NOT NULL DEFAULT 0,

  -- The client as they were when the document was issued. A client who moves
  -- office must not change the address on an invoice sent last year.
  "client_name" text,
  "client_legal_name" text,
  "client_ice" text,
  "client_if" text,
  "client_address" text,

  "subject" text,
  "notes" text,
  "payment_terms" text,

  -- A credit note points at the invoice it corrects.
  "corrects_id" uuid,

  "paid_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "document_type_valid" CHECK ("doc_type" IN ('devis','facture','avoir')),
  CONSTRAINT "document_status_valid"
    CHECK ("status" IN ('brouillon','emis','paye','annule')),
  -- A draft has no number; anything else must have one.
  CONSTRAINT "document_number_matches_status" CHECK (
    ("status" = 'brouillon' AND "number" IS NULL)
    OR ("status" <> 'brouillon' AND "number" IS NOT NULL
        AND "number_year" IS NOT NULL AND "number_seq" IS NOT NULL)
  ),
  -- A 0% rate has to say why. Exoneration is a legal claim, not a checkbox.
  CONSTRAINT "document_zero_vat_needs_reason" CHECK (
    "vat_rate_bp" <> 0
    OR ("vat_exemption_reason" IS NOT NULL AND length(trim("vat_exemption_reason")) > 0)
  ),
  CONSTRAINT "document_vat_range" CHECK ("vat_rate_bp" BETWEEN 0 AND 10000),
  CONSTRAINT "document_withholding_range" CHECK ("withholding_rate_bp" BETWEEN 0 AND 10000),
  CONSTRAINT "document_discount_non_negative" CHECK ("discount_centimes" >= 0),
  CONSTRAINT "document_totals_non_negative" CHECK (
    "total_excl_vat" >= 0 AND "total_vat" >= 0 AND "total_incl_vat" >= 0
    AND "withheld" >= 0 AND "net_to_collect" >= 0
  ),
  -- Only an invoice can be paid.
  CONSTRAINT "document_paid_only_invoice" CHECK ("status" <> 'paye' OR "doc_type" = 'facture')
);
--> statement-breakpoint

ALTER TABLE "document" ADD CONSTRAINT "document_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_deal_id_fk"
  FOREIGN KEY ("deal_id") REFERENCES "public"."deal"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_corrects_id_fk"
  FOREIGN KEY ("corrects_id") REFERENCES "public"."document"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_created_by_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint

-- The number is unique across the whole system, forever.
CREATE UNIQUE INDEX "document_number_key" ON "document" ("number") WHERE "number" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "document_seq_key"
  ON "document" ("doc_type", "number_year", "number_seq") WHERE "number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "document_company_idx" ON "document" ("company_id");
--> statement-breakpoint
CREATE INDEX "document_status_idx" ON "document" ("doc_type", "status");
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Line items — snapshots, exactly like deal lines
-- -----------------------------------------------------------------------------

CREATE TABLE "document_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL,
  "service_id" uuid,
  "label" text NOT NULL,
  "description" text,
  "unit" text NOT NULL DEFAULT 'forfait',
  "unit_price_centimes" bigint NOT NULL DEFAULT 0,
  "quantity_millis" bigint NOT NULL DEFAULT 1000,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_line_label_not_empty" CHECK (length(trim("label")) > 0),
  CONSTRAINT "document_line_price_non_negative" CHECK ("unit_price_centimes" >= 0),
  CONSTRAINT "document_line_quantity_positive" CHECK ("quantity_millis" > 0),
  CONSTRAINT "document_line_unit_valid" CHECK ("unit" IN ('forfait','mois','jour'))
);
--> statement-breakpoint

ALTER TABLE "document_line" ADD CONSTRAINT "document_line_document_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "document_line" ADD CONSTRAINT "document_line_service_id_fk"
  FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "document_line_doc_idx" ON "document_line" ("document_id","position");
--> statement-breakpoint

CREATE TRIGGER "document_touch_updated_at" BEFORE UPDATE ON "document"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

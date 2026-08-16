-- =============================================================================
-- 0016 — Finance: every dirham in and out.
--
-- One ledger table. `direction` gives the sign; the amount itself is always
-- positive, so a sign error cannot silently turn a cost into income.
--
-- Revenue posts itself: a trigger writes the income line when an invoice is
-- marked paid. Booking it from application code would mean an invoice could be
-- paid without the money ever appearing in the accounts.
-- =============================================================================

CREATE TABLE "finance_entry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "direction" text NOT NULL,
  "amount_centimes" bigint NOT NULL,
  /* VAT contained in the amount, for the accountant. Not a separate movement. */
  "vat_centimes" bigint NOT NULL DEFAULT 0,
  "entry_date" date NOT NULL DEFAULT current_date,
  "category" text NOT NULL,
  "payment_method" text NOT NULL DEFAULT 'virement',
  "description" text,
  /* Where the money came from or went to, when it is a known client. */
  "company_id" uuid,
  /* Set when this line was posted from an invoice being paid. */
  "document_id" uuid,
  /* Receipt or invoice reference, so the fiduciaire can match it to paper. */
  "reference" text,
  /* true when written by the trigger rather than typed in by hand. */
  "is_automatic" boolean NOT NULL DEFAULT false,
  "recorded_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "finance_direction_valid" CHECK ("direction" IN ('income','expense')),
  -- Always positive. The direction carries the sign, not the figure.
  CONSTRAINT "finance_amount_positive" CHECK ("amount_centimes" > 0),
  CONSTRAINT "finance_vat_range"
    CHECK ("vat_centimes" >= 0 AND "vat_centimes" <= "amount_centimes"),
  CONSTRAINT "finance_payment_method_valid" CHECK ("payment_method" IN
    ('especes','virement','cheque','carte','autre')),
  CONSTRAINT "finance_category_valid" CHECK ("category" IN (
    -- income
    'facture','autre_revenu',
    -- expense
    'loyer','electricite','eau','internet','telephone','equipement','logiciel',
    'salaires','sous_traitance','marketing','deplacement','impots','frais_bancaires',
    'fournitures','autre_depense')),
  -- An automatic line must say which invoice produced it.
  CONSTRAINT "finance_auto_has_document"
    CHECK (NOT "is_automatic" OR "document_id" IS NOT NULL)
);
--> statement-breakpoint

ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_document_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_recorded_by_id_fk"
  FOREIGN KEY ("recorded_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint

-- One income line per invoice, ever. Marking an invoice paid twice cannot
-- double-count the revenue.
CREATE UNIQUE INDEX "finance_one_line_per_document"
  ON "finance_entry" ("document_id") WHERE "document_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "finance_date_idx" ON "finance_entry" ("entry_date" DESC);
--> statement-breakpoint
CREATE INDEX "finance_direction_idx" ON "finance_entry" ("direction","entry_date");
--> statement-breakpoint

CREATE TRIGGER "finance_touch_updated_at" BEFORE UPDATE ON "finance_entry"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Revenue posts itself when an invoice is marked paid.
--
-- The amount booked is `net_to_collect`, not the total including VAT: with
-- withholding at source the client keeps part of the VAT, so the total is not
-- what actually arrives. The ledger tracks money, so it books what arrives.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.post_invoice_revenue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_client text;
BEGIN
  IF NEW.status = 'paye' AND OLD.status IS DISTINCT FROM 'paye'
     AND NEW.doc_type = 'facture' THEN

    SELECT name INTO v_client FROM company WHERE id = NEW.company_id;

    INSERT INTO finance_entry (
      direction, amount_centimes, vat_centimes, entry_date, category,
      payment_method, description, company_id, document_id, reference,
      is_automatic, recorded_by_id
    ) VALUES (
      'income',
      NEW.net_to_collect,
      greatest(NEW.total_vat - NEW.withheld, 0),
      coalesce(NEW.paid_at::date, current_date),
      'facture',
      'virement',
      concat('Invoice ', NEW.number, ' — ', coalesce(v_client, 'client')),
      NEW.company_id,
      NEW.id,
      NEW.number,
      true,
      app.current_user_id()
    )
    -- The partial unique index already prevents a second line; this keeps the
    -- update from failing outright if it is somehow retried.
    ON CONFLICT (document_id) WHERE document_id IS NOT NULL DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "document_posts_revenue" AFTER UPDATE ON "document"
  FOR EACH ROW EXECUTE FUNCTION app.post_invoice_revenue();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Row level security — the accounts are management only, as the brief requires.
-- -----------------------------------------------------------------------------

ALTER TABLE "finance_entry" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "finance_entry" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "finance_admin" ON "finance_entry" FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint
-- The revenue trigger runs inside whatever session marked the invoice paid,
-- which is an admin session by the document policy — but bootstrap needs a way
-- in for migrations and the seed.
CREATE POLICY "finance_bootstrap" ON "finance_entry" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

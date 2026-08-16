-- =============================================================================
-- 0011 — Services on a deal, and a money discount.
--
-- Lines are SNAPSHOTS. `label`, `unit` and `unit_price_centimes` are copied from
-- the catalog when the line is added. Raising a price next month must not move
-- the value of a deal already agreed, and must not rewrite a quote already sent.
-- The `service_id` link is kept for reporting and may go null.
--
-- The discount is a fixed amount in centimes, not a percentage: that is how it
-- gets agreed with a client and how it prints on the document.
-- =============================================================================

ALTER TABLE "deal" ADD COLUMN "discount_centimes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_discount_non_negative"
  CHECK ("discount_centimes" >= 0);
--> statement-breakpoint

CREATE TABLE "deal_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" uuid NOT NULL,
  "service_id" uuid,
  "label" text NOT NULL,
  "unit" text DEFAULT 'forfait' NOT NULL,
  "unit_price_centimes" bigint DEFAULT 0 NOT NULL,
  "quantity_millis" bigint DEFAULT 1000 NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deal_line_label_not_empty" CHECK (length(trim("label")) > 0),
  CONSTRAINT "deal_line_price_non_negative" CHECK ("unit_price_centimes" >= 0),
  -- A zero quantity is a line that should have been deleted.
  CONSTRAINT "deal_line_quantity_positive" CHECK ("quantity_millis" > 0),
  CONSTRAINT "deal_line_unit_valid" CHECK ("unit" IN ('forfait','mois','jour'))
);
--> statement-breakpoint

ALTER TABLE "deal_line" ADD CONSTRAINT "deal_line_deal_id_fk"
  FOREIGN KEY ("deal_id") REFERENCES "public"."deal"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "deal_line" ADD CONSTRAINT "deal_line_service_id_fk"
  FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "deal_line_deal_idx" ON "deal_line" USING btree ("deal_id","position");
--> statement-breakpoint

-- Lines carry money, so they follow the deal: management and the work
-- moderator only. A member querying this table gets nothing.
ALTER TABLE "deal_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "deal_line_all" ON "deal_line" FOR ALL
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "deal_line_bootstrap" ON "deal_line" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

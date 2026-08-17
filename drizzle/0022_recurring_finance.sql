-- =============================================================================
-- 0022 — Recurring costs that post themselves.
--
-- Rent, electricity, internet and subscriptions are the same figure every
-- month. Typing them twelve times a year is the toil, and the month someone
-- forgets is the month the accounts are quietly wrong.
--
-- A template describes the cost; a function posts whatever is due. Posting is
-- idempotent by construction: `finance_entry` gains (recurring_entry_id,
-- period_key) under a unique index, so running the catch-up twice — or five
-- times, or after a restore — cannot double-count a single dirham.
-- =============================================================================

CREATE TABLE "recurring_entry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "direction" text NOT NULL DEFAULT 'expense',
  "amount_centimes" bigint NOT NULL,
  "vat_centimes" bigint NOT NULL DEFAULT 0,
  "category" text NOT NULL,
  "payment_method" text NOT NULL DEFAULT 'virement',
  "description" text NOT NULL,
  "company_id" uuid,
  "frequency" text NOT NULL DEFAULT 'monthly',
  /* Capped at 28 so February is never a special case. */
  "day_of_month" integer NOT NULL DEFAULT 1,
  "start_date" date NOT NULL DEFAULT current_date,
  "end_date" date,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "recurring_direction_valid" CHECK ("direction" IN ('income','expense')),
  CONSTRAINT "recurring_amount_positive" CHECK ("amount_centimes" > 0),
  CONSTRAINT "recurring_vat_range"
    CHECK ("vat_centimes" >= 0 AND "vat_centimes" <= "amount_centimes"),
  CONSTRAINT "recurring_frequency_valid"
    CHECK ("frequency" IN ('monthly','quarterly','yearly')),
  CONSTRAINT "recurring_day_valid" CHECK ("day_of_month" BETWEEN 1 AND 28),
  CONSTRAINT "recurring_description_not_empty" CHECK (length(trim("description")) > 0),
  CONSTRAINT "recurring_dates_ordered"
    CHECK ("end_date" IS NULL OR "end_date" >= "start_date"),
  CONSTRAINT "recurring_payment_method_valid" CHECK ("payment_method" IN
    ('especes','virement','cheque','carte','autre')),
  CONSTRAINT "recurring_category_valid" CHECK ("category" IN (
    'facture','autre_revenu',
    'loyer','electricite','eau','internet','telephone','equipement','logiciel',
    'salaires','sous_traitance','marketing','deplacement','impots','frais_bancaires',
    'fournitures','autre_depense'))
);
--> statement-breakpoint

ALTER TABLE "recurring_entry" ADD CONSTRAINT "recurring_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "recurring_entry" ADD CONSTRAINT "recurring_created_by_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint

CREATE TRIGGER "recurring_touch_updated_at" BEFORE UPDATE ON "recurring_entry"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- The link back, and the thing that makes double-posting impossible.
ALTER TABLE "finance_entry" ADD COLUMN "recurring_entry_id" uuid;
--> statement-breakpoint
ALTER TABLE "finance_entry" ADD COLUMN "period_key" text;
--> statement-breakpoint
ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_recurring_entry_id_fk"
  FOREIGN KEY ("recurring_entry_id") REFERENCES "public"."recurring_entry"("id") ON DELETE set null;
--> statement-breakpoint

CREATE UNIQUE INDEX "finance_one_line_per_period"
  ON "finance_entry" ("recurring_entry_id", "period_key")
  WHERE "recurring_entry_id" IS NOT NULL;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The catch-up.
--
-- Walks every active template from its start date to today and posts any period
-- that has no line yet. Safe to call at any moment, from anywhere, any number
-- of times — the unique index is what guarantees that, not the caller's care.
--
-- Deliberately posts EVERY missed period, not just the current one: a stack
-- that was off for three weeks should come back with three weeks of rent
-- recorded, not one.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.post_due_recurring(p_today date DEFAULT current_date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r          recurring_entry%ROWTYPE;
  v_cursor   date;
  v_period   text;
  v_due      date;
  v_posted   integer := 0;
  v_step     interval;
BEGIN
  FOR r IN
    SELECT * FROM recurring_entry
     WHERE is_active
       AND start_date <= p_today
       AND (end_date IS NULL OR end_date >= start_date)
  LOOP
    v_step := CASE r.frequency
                WHEN 'monthly'   THEN interval '1 month'
                WHEN 'quarterly' THEN interval '3 months'
                ELSE                  interval '1 year'
              END;

    -- Start at the first period boundary on or before start_date.
    v_cursor := date_trunc(
      CASE r.frequency WHEN 'yearly' THEN 'year' ELSE 'month' END,
      r.start_date
    )::date;

    WHILE v_cursor <= p_today LOOP
      v_due := v_cursor + (r.day_of_month - 1);

      -- Only post once the day has actually arrived, and never past the end.
      IF v_due <= p_today
         AND v_due >= r.start_date
         AND (r.end_date IS NULL OR v_due <= r.end_date) THEN

        v_period := CASE r.frequency
                      WHEN 'yearly'    THEN to_char(v_cursor, 'YYYY')
                      WHEN 'quarterly' THEN to_char(v_cursor, 'YYYY') || '-Q' ||
                                            to_char(extract(quarter FROM v_cursor), 'FM9')
                      ELSE                  to_char(v_cursor, 'YYYY-MM')
                    END;

        INSERT INTO finance_entry (
          direction, amount_centimes, vat_centimes, entry_date, category,
          payment_method, description, company_id, reference, is_automatic,
          recorded_by_id, recurring_entry_id, period_key
        ) VALUES (
          r.direction, r.amount_centimes, r.vat_centimes, v_due, r.category,
          r.payment_method, r.description || ' — ' || v_period, r.company_id,
          NULL, true, r.created_by_id, r.id, v_period
        )
        ON CONFLICT (recurring_entry_id, period_key)
          WHERE recurring_entry_id IS NOT NULL DO NOTHING;

        IF FOUND THEN v_posted := v_posted + 1; END IF;
      END IF;

      v_cursor := (v_cursor + v_step)::date;
    END LOOP;
  END LOOP;

  RETURN v_posted;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.post_due_recurring(date) FROM PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Row level security — the accounts are management only.
-- -----------------------------------------------------------------------------

ALTER TABLE "recurring_entry" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "recurring_entry" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "recurring_admin" ON "recurring_entry" FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint
CREATE POLICY "recurring_bootstrap" ON "recurring_entry" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

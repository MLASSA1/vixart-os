-- =============================================================================
-- 0020 — Equipment register.
--
-- What the agency owns and who has it. Cameras, lenses, laptops, mics, drives.
--
-- Purchase cost is recorded here as a reference figure, NOT as a movement: the
-- money left the account when the expense was recorded in `finance_entry`, and
-- counting it twice would overstate spending. `finance_entry_id` links the
-- register to that expense so the two agree.
-- =============================================================================

CREATE TABLE "equipment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "category" text NOT NULL DEFAULT 'autre',
  "brand" text,
  "model" text,
  "serial_number" text,
  "status" text NOT NULL DEFAULT 'available',
  /* Who currently holds it. NULL when it is in the office. */
  "assigned_to_id" uuid,
  "assigned_at" timestamp with time zone,
  "purchase_date" date,
  /* Reference only — the actual spend lives in finance_entry. */
  "purchase_cost_centimes" bigint NOT NULL DEFAULT 0,
  "finance_entry_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "equipment_name_not_empty" CHECK (length(trim("name")) > 0),
  CONSTRAINT "equipment_category_valid" CHECK ("category" IN
    ('camera','lens','audio','lighting','computer','phone','drone','storage','accessory','autre')),
  CONSTRAINT "equipment_status_valid" CHECK ("status" IN
    ('available','assigned','repair','retired','lost')),
  CONSTRAINT "equipment_cost_non_negative" CHECK ("purchase_cost_centimes" >= 0),
  -- Assigned means assigned to someone. Anything else has no holder.
  CONSTRAINT "equipment_assignment_coherent" CHECK (
    ("status" = 'assigned' AND "assigned_to_id" IS NOT NULL)
    OR ("status" <> 'assigned' AND "assigned_to_id" IS NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "equipment" ADD CONSTRAINT "equipment_assigned_to_id_fk"
  FOREIGN KEY ("assigned_to_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_finance_entry_id_fk"
  FOREIGN KEY ("finance_entry_id") REFERENCES "public"."finance_entry"("id") ON DELETE set null;
--> statement-breakpoint

CREATE UNIQUE INDEX "equipment_serial_key" ON "equipment" (lower("serial_number"))
  WHERE "serial_number" IS NOT NULL AND length(trim("serial_number")) > 0;
--> statement-breakpoint
CREATE INDEX "equipment_status_idx" ON "equipment" ("status");
--> statement-breakpoint
CREATE INDEX "equipment_assigned_idx" ON "equipment" ("assigned_to_id");
--> statement-breakpoint

CREATE TRIGGER "equipment_touch_updated_at" BEFORE UPDATE ON "equipment"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- Keep assigned_at honest without asking the application to remember.
CREATE OR REPLACE FUNCTION app.stamp_equipment_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_to_id IS DISTINCT FROM OLD.assigned_to_id THEN
    NEW.assigned_at := CASE WHEN NEW.assigned_to_id IS NULL THEN NULL ELSE now() END;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "equipment_stamp_assignment" BEFORE UPDATE ON "equipment"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_equipment_assignment();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Row level security
--
-- The whole team can see the register — knowing who has the A7S matters to
-- everyone on a shoot. Only a moderator or admin can add kit or move it, and
-- the purchase cost is a money field, so it is filtered out of the query for
-- members in the page rather than exposed here.
-- -----------------------------------------------------------------------------

ALTER TABLE "equipment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "equipment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "equipment_read" ON "equipment" FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "equipment_write" ON "equipment" FOR ALL
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "equipment_bootstrap" ON "equipment" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

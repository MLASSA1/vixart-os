-- =============================================================================
-- 0025 — Agent foundation: the fiscal calendar and the effort log.
--
-- Two gaps that stop a finance agent from answering honestly:
--
--   * nothing modelled tax deadlines, so "what is due" had no source
--   * `task` had no hours, so revenue was knowable and the cost of delivering
--     it was not — margin could only ever be half a number
--
-- Neither table is agent-specific. They are business tables the agent reads.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. declaration — the fiscal calendar
--
-- `kind` is deliberately wider than what VIXART files today. The team's status
-- (salarié vs prestataire) is not settled; the build assumes prestataire, so no
-- CNSS or IR rows are created. Both values are already legal in the CHECK, so
-- the day that changes it is a data change, not a migration.
--
-- SALARIÉ SUPPORT ATTACHES HERE: insert 'cnss' rows monthly and 'ir' rows
-- monthly alongside the existing TVA rows. Nothing else in this file changes.
-- -----------------------------------------------------------------------------

CREATE TABLE "declaration" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  /* Human label for the period: '2026-T3', '2026-09'. */
  "period_label" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "due_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'upcoming',
  /* Often unknown until the period is computed, so nullable — and a nullable
     amount is honest where a 0 would read as "nothing to pay". */
  "amount_centimes" bigint,
  "filed_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  /* Télédéclaration or receipt number. */
  "reference" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "declaration_kind_valid" CHECK ("kind" IN
    ('tva','is_acompte','is_solde','cnss','ir','other')),
  CONSTRAINT "declaration_status_valid" CHECK ("status" IN
    ('upcoming','due','filed','paid','late')),
  CONSTRAINT "declaration_period_ordered" CHECK ("period_end" >= "period_start"),
  /* A declaration is filed for a period that has ended. */
  CONSTRAINT "declaration_due_after_period" CHECK ("due_date" >= "period_start"),
  CONSTRAINT "declaration_amount_non_negative"
    CHECK ("amount_centimes" IS NULL OR "amount_centimes" >= 0),
  CONSTRAINT "declaration_label_not_empty" CHECK (length(trim("period_label")) > 0),
  /* Claiming it is filed without saying when is how a calendar starts lying. */
  CONSTRAINT "declaration_filed_has_date"
    CHECK ("status" NOT IN ('filed','paid') OR "filed_at" IS NOT NULL),
  CONSTRAINT "declaration_paid_has_date"
    CHECK ("status" <> 'paid' OR "paid_at" IS NOT NULL)
);
--> statement-breakpoint

/* One row per kind per period. Filing the same quarter twice is a mistake. */
CREATE UNIQUE INDEX "declaration_kind_period_key"
  ON "declaration" ("kind", "period_label");
--> statement-breakpoint
CREATE INDEX "declaration_due_idx" ON "declaration" ("due_date");
--> statement-breakpoint
CREATE INDEX "declaration_status_idx" ON "declaration" ("status", "due_date");
--> statement-breakpoint

CREATE TRIGGER "declaration_touch_updated_at" BEFORE UPDATE ON "declaration"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

/* Stamp the dates rather than trusting whoever writes the row to remember. */
CREATE OR REPLACE FUNCTION app.stamp_declaration_dates() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('filed','paid') AND NEW.filed_at IS NULL THEN
    NEW.filed_at := now();
  END IF;
  IF NEW.status = 'paid' AND NEW.paid_at IS NULL THEN
    NEW.paid_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "declaration_stamp_dates"
  BEFORE INSERT OR UPDATE ON "declaration"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_declaration_dates();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. effort_log — labour against work
--
-- MINUTES, integer. Same reasoning as money being centimes: 1.5 hours and 0.1
-- hours are both exactly representable as minutes, and neither is exactly
-- representable as a float. Nothing here ever needs a decimal.
-- -----------------------------------------------------------------------------

CREATE TABLE "effort_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "minutes" integer NOT NULL,
  "logged_on" date NOT NULL DEFAULT current_date,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "effort_minutes_positive" CHECK ("minutes" > 0),
  /* A day has 1440 minutes. Anything above that is a typo, not a long day. */
  CONSTRAINT "effort_minutes_sane" CHECK ("minutes" <= 1440),
  CONSTRAINT "effort_not_in_future" CHECK ("logged_on" <= current_date + 1)
);
--> statement-breakpoint

ALTER TABLE "effort_log" ADD CONSTRAINT "effort_log_task_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "effort_log" ADD CONSTRAINT "effort_log_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict;
--> statement-breakpoint

CREATE INDEX "effort_log_task_idx" ON "effort_log" ("task_id");
--> statement-breakpoint
CREATE INDEX "effort_log_user_date_idx" ON "effort_log" ("user_id", "logged_on");
--> statement-breakpoint

CREATE TRIGGER "effort_log_touch_updated_at" BEFORE UPDATE ON "effort_log"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

/* You log your own effort. A moderator or admin may log on someone's behalf,
   but nobody quietly books hours against a colleague. */
CREATE OR REPLACE FUNCTION app.enforce_effort_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() THEN RETURN NEW; END IF;

  IF NEW.user_id <> app.current_user_id() AND NOT app.is_moderator() THEN
    RAISE EXCEPTION 'You can only log effort against your own name.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "effort_log_ownership"
  BEFORE INSERT OR UPDATE ON "effort_log"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_effort_ownership();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Row level security
-- -----------------------------------------------------------------------------

ALTER TABLE "declaration" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "declaration" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
/* Tax deadlines are money. Management only, same boundary as the ledger. */
CREATE POLICY "declaration_admin" ON "declaration" FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint
CREATE POLICY "declaration_bootstrap" ON "declaration" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

ALTER TABLE "effort_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "effort_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
/* The team sees effort — knowing a task ate three days is useful to everyone
   on it. What effort costs is a separate table they cannot read. */
CREATE POLICY "effort_log_read" ON "effort_log" FOR SELECT
  USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "effort_log_write" ON "effort_log" FOR INSERT
  WITH CHECK (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "effort_log_update" ON "effort_log" FOR UPDATE
  USING (app.is_moderator() OR "user_id" = app.current_user_id())
  WITH CHECK (app.is_moderator() OR "user_id" = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "effort_log_delete" ON "effort_log" FOR DELETE
  USING (app.is_moderator() OR "user_id" = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "effort_log_bootstrap" ON "effort_log" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

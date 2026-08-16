-- =============================================================================
-- 0012 — Phase 2: pipeline stages, project types, activity tracking, comments.
--
-- Follows the architecture diagram: the lead/deal pipeline gains the stages
-- drawn there, projects gain a type, and the "Activity Tracking" and
-- "Communication" modules get their tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pipeline stages as drawn: New Lead -> Contacted -> Meeting Booked ->
--    Proposal -> Negotiation -> Won / Lost.
--
-- The old four stages are kept as valid values so existing deals stay legal;
-- they simply sit further along the same funnel.
-- -----------------------------------------------------------------------------

ALTER TABLE "deal" DROP CONSTRAINT "deal_stage_valid";
--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_stage_valid" CHECK ("stage" IN (
  'new_lead','contacted','meeting_booked','proposal','negotiation','won','lost'));
--> statement-breakpoint
ALTER TABLE "deal" ALTER COLUMN "stage" SET DEFAULT 'new_lead';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Project types, as drawn: Branding, Website, Ads Campaign, Video.
-- -----------------------------------------------------------------------------

ALTER TABLE "project" ADD COLUMN "project_type" text DEFAULT 'branding' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_type_valid" CHECK ("project_type" IN (
  'branding','website','ads_campaign','video','other'));
--> statement-breakpoint

-- Client budget, from the Client Management module.
ALTER TABLE "company" ADD COLUMN "budget_centimes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_budget_non_negative"
  CHECK ("budget_centimes" >= 0);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Activity tracking
--
-- Written by triggers, not by application code. An audit trail that depends on
-- every call site remembering to log is an audit trail with holes in it.
-- Append-only: a trigger refuses UPDATE and DELETE.
-- -----------------------------------------------------------------------------

CREATE TABLE "activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid,
  "actor_name" text NOT NULL DEFAULT 'system',
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "entity_label" text,
  "action" text NOT NULL,
  "detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "activity_entity_type_valid" CHECK ("entity_type" IN
    ('company','deal','project','task','service','user'))
);
--> statement-breakpoint

ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity" USING btree ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX "activity_entity_idx" ON "activity" USING btree ("entity_type","entity_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.forbid_activity_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The activity log is append-only.'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "activity_append_only" BEFORE UPDATE OR DELETE ON "activity"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_activity_rewrite();
--> statement-breakpoint

/* Resolves the acting user's display name from the session context. */
CREATE OR REPLACE FUNCTION app.actor_name() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT full_name FROM app_user WHERE id = app.current_user_id()), 'system');
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.log_task_activity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE verb text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    verb := 'created';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    verb := 'moved to ' || NEW.status;
  ELSE
    RETURN NEW;   -- nothing worth recording
  END IF;

  INSERT INTO activity (actor_id, actor_name, entity_type, entity_id, entity_label, action)
  VALUES (app.current_user_id(), app.actor_name(), 'task', NEW.id, NEW.title, verb);
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "task_activity" AFTER INSERT OR UPDATE ON "task"
  FOR EACH ROW EXECUTE FUNCTION app.log_task_activity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.log_deal_activity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE verb text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    verb := 'created';
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
    verb := 'moved to ' || NEW.stage;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO activity (actor_id, actor_name, entity_type, entity_id, entity_label, action)
  VALUES (app.current_user_id(), app.actor_name(), 'deal', NEW.id, NEW.title, verb);
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "deal_activity" AFTER INSERT OR UPDATE ON "deal"
  FOR EACH ROW EXECUTE FUNCTION app.log_deal_activity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.log_company_activity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE verb text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    verb := 'added';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    verb := 'moved to ' || NEW.status::text;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO activity (actor_id, actor_name, entity_type, entity_id, entity_label, action)
  VALUES (app.current_user_id(), app.actor_name(), 'company', NEW.id, NEW.name, verb);
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "company_activity" AFTER INSERT OR UPDATE ON "company"
  FOR EACH ROW EXECUTE FUNCTION app.log_company_activity();
--> statement-breakpoint

ALTER TABLE "activity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "activity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "activity_select" ON "activity" FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
-- Only the triggers write here; nothing inserts by hand.
CREATE POLICY "activity_insert" ON "activity" FOR INSERT WITH CHECK (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "activity_bootstrap" ON "activity" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Comments — the Communication module's internal thread
-- -----------------------------------------------------------------------------

CREATE TABLE "comment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "author_id" uuid,
  "author_name" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comment_body_not_empty" CHECK (length(trim("body")) > 0),
  CONSTRAINT "comment_entity_type_valid" CHECK ("entity_type" IN ('project','task','company'))
);
--> statement-breakpoint

ALTER TABLE "comment" ADD CONSTRAINT "comment_author_id_fk"
  FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "comment_entity_idx" ON "comment" USING btree ("entity_type","entity_id","created_at");
--> statement-breakpoint

ALTER TABLE "comment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "comment_select" ON "comment" FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
-- You comment in your own name, never a colleague's.
CREATE POLICY "comment_insert" ON "comment"
  FOR INSERT WITH CHECK (app.is_authenticated() AND "author_id" = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "comment_delete" ON "comment"
  FOR DELETE USING (app.is_admin() OR "author_id" = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "comment_bootstrap" ON "comment" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

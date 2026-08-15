-- =============================================================================
-- 0006 — Work module: companies, deals, projects, tasks, moderator role.
--
-- Hand-written rather than generated. `drizzle-kit generate` cannot tell a
-- renamed table from a dropped-and-recreated one without an interactive answer,
-- and the wrong answer here would DROP the pipeline. Renaming in place is the
-- only acceptable version, so it is written out explicitly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. client -> company
--
-- One table now holds every organisation: clients, suppliers, partners.
-- `relationship` says what they are, `status` says where they are in the
-- pipeline. Clients and Leads become filtered views of the same table.
-- Renames preserve every row, index, constraint and policy.
-- -----------------------------------------------------------------------------

ALTER TABLE "client" RENAME TO "company";
--> statement-breakpoint
ALTER TABLE "contact" RENAME COLUMN "client_id" TO "company_id";
--> statement-breakpoint
ALTER TABLE "interaction" RENAME COLUMN "client_id" TO "company_id";
--> statement-breakpoint

ALTER INDEX "client_name_key" RENAME TO "company_name_key";
--> statement-breakpoint
ALTER INDEX "client_status_idx" RENAME TO "company_status_idx";
--> statement-breakpoint
ALTER INDEX "contact_client_idx" RENAME TO "contact_company_idx";
--> statement-breakpoint
ALTER INDEX "interaction_client_date_idx" RENAME TO "interaction_company_date_idx";
--> statement-breakpoint

ALTER TABLE "company" RENAME CONSTRAINT "client_ice_shape" TO "company_ice_shape";
--> statement-breakpoint
ALTER TABLE "company" RENAME CONSTRAINT "client_if_shape" TO "company_if_shape";
--> statement-breakpoint
ALTER TABLE "contact" RENAME CONSTRAINT "contact_client_id_client_id_fk" TO "contact_company_id_fk";
--> statement-breakpoint
ALTER TABLE "interaction" RENAME CONSTRAINT "interaction_client_id_client_id_fk" TO "interaction_company_id_fk";
--> statement-breakpoint

ALTER POLICY "client_select" ON "company" RENAME TO "company_select";
--> statement-breakpoint
ALTER POLICY "client_insert" ON "company" RENAME TO "company_insert";
--> statement-breakpoint
ALTER POLICY "client_update" ON "company" RENAME TO "company_update";
--> statement-breakpoint
ALTER POLICY "client_delete_admin" ON "company" RENAME TO "company_delete_admin";
--> statement-breakpoint
ALTER POLICY "client_bootstrap" ON "company" RENAME TO "company_bootstrap";
--> statement-breakpoint
ALTER TRIGGER "client_touch_updated_at" ON "company" RENAME TO "company_touch_updated_at";
--> statement-breakpoint

ALTER TABLE "company" ADD COLUMN "relationship" text DEFAULT 'client' NOT NULL;
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_relationship_valid"
  CHECK ("relationship" IN ('client', 'supplier', 'partner', 'other'));
--> statement-breakpoint
CREATE INDEX "company_relationship_idx" ON "company" USING btree ("relationship");
--> statement-breakpoint

-- Consent, not a preference: excluded from every marketing export.
ALTER TABLE "contact" ADD COLUMN "opted_out" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Third role: moderator
--
-- `role` moves from a PostgreSQL enum to text + CHECK. ALTER TYPE ... ADD VALUE
-- cannot be used in the same transaction that adds it, and the migrator runs
-- every pending migration in one transaction — so extending the enum would
-- deadlock this file against itself. Text + CHECK gives the same guarantee.
--
-- The column is referenced by an RLS policy, and PostgreSQL refuses to alter
-- the type of a column used in a policy, so the policy is dropped and rebuilt.
-- -----------------------------------------------------------------------------

DROP POLICY "app_user_update" ON "app_user";
--> statement-breakpoint

ALTER TABLE "app_user" ALTER COLUMN "role" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "role" TYPE text USING "role"::text;
--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "role" SET DEFAULT 'member';
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_role_valid"
  CHECK ("role" IN ('admin', 'moderator', 'member'));
--> statement-breakpoint

DROP TYPE IF EXISTS "user_role";
--> statement-breakpoint

-- A member may edit their own row but cannot promote themselves: the role must
-- stay 'member' on the new row unless an admin is doing the update.
CREATE POLICY "app_user_update" ON "app_user"
  FOR UPDATE
  USING (app.is_admin() OR "id" = app.current_user_id())
  WITH CHECK (
    app.is_admin()
    OR ("id" = app.current_user_id() AND "role" = 'member')
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_moderator() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() IN ('admin', 'moderator');
$$;
--> statement-breakpoint

-- Mohamed Amine moderates the work: assigns tasks, tracks progress, signs off
-- completion. Guarded so it cannot overwrite a role set deliberately later.
UPDATE "app_user" SET "role" = 'moderator'
 WHERE lower("email") = 'mohamed.amine@vixart.ma' AND "role" = 'member';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Deals — an opportunity with a value
-- -----------------------------------------------------------------------------

CREATE TABLE "deal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "value_centimes" bigint DEFAULT 0 NOT NULL,
  "stage" text DEFAULT 'proposal' NOT NULL,
  "probability" integer DEFAULT 50 NOT NULL,
  "expected_close_date" date,
  "owner_id" uuid,
  "closed_at" timestamp with time zone,
  "lost_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deal_stage_valid" CHECK ("stage" IN ('proposal','negotiation','won','lost')),
  CONSTRAINT "deal_probability_range" CHECK ("probability" BETWEEN 0 AND 100),
  -- Money is centimes. Negative opportunity values are meaningless.
  CONSTRAINT "deal_value_non_negative" CHECK ("value_centimes" >= 0),
  -- A lost deal has to say why. That field is the point of tracking losses.
  CONSTRAINT "deal_lost_needs_reason"
    CHECK ("stage" <> 'lost' OR ("lost_reason" IS NOT NULL AND length(trim("lost_reason")) > 0))
);
--> statement-breakpoint

ALTER TABLE "deal" ADD CONSTRAINT "deal_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_owner_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "deal_company_idx" ON "deal" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "deal_stage_idx" ON "deal" USING btree ("stage");
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Projects — delivery of a won deal
-- -----------------------------------------------------------------------------

CREATE TABLE "project" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "deal_id" uuid,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'planned' NOT NULL,
  "start_date" date,
  "due_date" date,
  "lead_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_status_valid"
    CHECK ("status" IN ('planned','active','on_hold','delivered')),
  CONSTRAINT "project_name_not_empty" CHECK (length(trim("name")) > 0),
  CONSTRAINT "project_dates_ordered"
    CHECK ("start_date" IS NULL OR "due_date" IS NULL OR "due_date" >= "start_date")
);
--> statement-breakpoint

ALTER TABLE "project" ADD CONSTRAINT "project_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_deal_id_fk"
  FOREIGN KEY ("deal_id") REFERENCES "public"."deal"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_id_fk"
  FOREIGN KEY ("lead_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "project_company_idx" ON "project" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "project_status_idx" ON "project" USING btree ("status");
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. Tasks — assigned work with a two-step sign-off
-- -----------------------------------------------------------------------------

CREATE TABLE "task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "assignee_id" uuid,
  "status" text DEFAULT 'todo' NOT NULL,
  "priority" text DEFAULT 'normal' NOT NULL,
  "due_date" date,
  "created_by_id" uuid,
  "submitted_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "completed_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "task_status_valid"
    CHECK ("status" IN ('todo','in_progress','submitted','completed')),
  CONSTRAINT "task_priority_valid"
    CHECK ("priority" IN ('low','normal','high','urgent')),
  CONSTRAINT "task_title_not_empty" CHECK (length(trim("title")) > 0),
  -- A completed task must carry who signed it off and when.
  CONSTRAINT "task_completion_recorded" CHECK (
    "status" <> 'completed'
    OR ("completed_at" IS NOT NULL AND "completed_by_id" IS NOT NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "task" ADD CONSTRAINT "task_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_id_fk"
  FOREIGN KEY ("assignee_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_completed_by_id_fk"
  FOREIGN KEY ("completed_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "task_project_idx" ON "task" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "task_assignee_status_idx" ON "task" USING btree ("assignee_id","status");
--> statement-breakpoint
CREATE INDEX "task_due_idx" ON "task" USING btree ("due_date");
--> statement-breakpoint

CREATE TRIGGER "deal_touch_updated_at" BEFORE UPDATE ON "deal"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "project_touch_updated_at" BEFORE UPDATE ON "project"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "task_touch_updated_at" BEFORE UPDATE ON "task"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

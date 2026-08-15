-- =============================================================================
-- 0001 — Foundation rules: session context, RLS, timestamps, checks.
--
-- Everything here is hand-written: these are the guard rails that must survive
-- a bug in application code. PostgreSQL is the last line of defence, not the
-- interface.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Application session context
--
-- The application sets `app.user_id` and `app.user_role` at the start of every
-- transaction (SET LOCAL). RLS policies read those settings. SET LOCAL means
-- the context dies with the transaction, even when the pool recycles the
-- connection.
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.user_role', true), ''), 'anonymous');
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() = 'admin';
$$;
--> statement-breakpoint

-- Any signed-in session: admin or member. `anonymous` sees nothing.
CREATE OR REPLACE FUNCTION app.is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() IN ('admin', 'member');
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA app TO PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Automatic timestamps — `updated_at` does not depend on application code.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER app_user_touch_updated_at
  BEFORE UPDATE ON "app_user"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER client_touch_updated_at
  BEFORE UPDATE ON "client"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Business integrity checks
-- -----------------------------------------------------------------------------

-- A rate is a positive integer of basis points, capped at 100%.
ALTER TABLE "fiscal_rate"
  ADD CONSTRAINT fiscal_rate_bp_range CHECK ("rate_bp" >= 0 AND "rate_bp" <= 10000);
--> statement-breakpoint

-- A tax parameter is never overwritten: a dated version is appended.
-- Any attempt to modify an existing version is refused.
CREATE OR REPLACE FUNCTION app.forbid_fiscal_rate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'A tax parameter is versioned and immutable (key "%", in force from %). '
    'Insert a new version with a later effective_from date instead.',
    OLD.key, OLD.effective_from
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER fiscal_rate_immutable
  BEFORE UPDATE OR DELETE ON "fiscal_rate"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_fiscal_rate_update();
--> statement-breakpoint

-- A team email must look like an email.
ALTER TABLE "app_user"
  ADD CONSTRAINT app_user_email_shape CHECK ("email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
--> statement-breakpoint

-- A Moroccan ICE is 15 digits. The column is optional (a prospect may not have
-- given it yet) but must be valid when filled: a wrong ICE on an invoice is a
-- tax problem.
ALTER TABLE "client"
  ADD CONSTRAINT client_ice_shape CHECK ("ice" IS NULL OR "ice" ~ '^[0-9]{15}$');
--> statement-breakpoint

-- The Moroccan tax ID is numeric, 6 to 9 digits.
ALTER TABLE "client"
  ADD CONSTRAINT client_if_shape CHECK ("identifiant_fiscal" IS NULL OR "identifiant_fiscal" ~ '^[0-9]{6,9}$');
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
--
-- FORCE ROW LEVEL SECURITY: the policies apply even to the table owner.
-- Without FORCE, a misconfiguration running the application under the owner
-- role would silently disable all of this. That door is closed now.
--
-- Step 1: the three foundation tables. The Finance boundary (management only)
-- arrives with its own tables, at steps 3 and 5.
-- -----------------------------------------------------------------------------

ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_user" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The whole team sees the team directory (needed to assign a task).
CREATE POLICY app_user_select ON "app_user"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint

-- Only an admin creates or deletes an account. A member edits only their own
-- row and cannot self-promote: the role is locked by the policy itself.
CREATE POLICY app_user_insert_admin ON "app_user"
  FOR INSERT WITH CHECK (app.is_admin());
--> statement-breakpoint

CREATE POLICY app_user_update ON "app_user"
  FOR UPDATE
  USING (app.is_admin() OR "id" = app.current_user_id())
  WITH CHECK (
    app.is_admin()
    OR ("id" = app.current_user_id() AND "role" = 'member')
  );
--> statement-breakpoint

CREATE POLICY app_user_delete_admin ON "app_user"
  FOR DELETE USING (app.is_admin());
--> statement-breakpoint

ALTER TABLE "client" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "client" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The whole team works the active client: everyone sees it.
-- What is fenced off is the money (steps 3 and 5), not the relationship.
CREATE POLICY client_select ON "client"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY client_insert ON "client"
  FOR INSERT WITH CHECK (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY client_update ON "client"
  FOR UPDATE USING (app.is_authenticated()) WITH CHECK (app.is_authenticated());
--> statement-breakpoint

-- Deleting a client record erases its history: management only.
CREATE POLICY client_delete_admin ON "client"
  FOR DELETE USING (app.is_admin());
--> statement-breakpoint

ALTER TABLE "fiscal_rate" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fiscal_rate" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Rates are readable by the application (document maths) but only management
-- can publish a new version.
CREATE POLICY fiscal_rate_select ON "fiscal_rate"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY fiscal_rate_insert_admin ON "fiscal_rate"
  FOR INSERT WITH CHECK (app.is_admin());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. Exemption for start-up tasks
--
-- Migrations and the seed run with no session context (no app.user_id). They
-- execute under the owner role, which is subject to the FORCE RLS above. They
-- get an explicit, named door rather than RLS being switched off:
-- `app.bootstrap = on` is set only by scripts/migrate.ts and
-- seed/vixart.seed.ts, never by an HTTP route.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.is_bootstrap() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bootstrap', true), 'off') = 'on';
$$;
--> statement-breakpoint

CREATE POLICY app_user_bootstrap ON "app_user" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint
CREATE POLICY client_bootstrap ON "client" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint
CREATE POLICY fiscal_rate_bootstrap ON "fiscal_rate" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

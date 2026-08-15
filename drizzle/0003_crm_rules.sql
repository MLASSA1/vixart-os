-- =============================================================================
-- 0003 — CRM rules: authentication, RLS for contacts and the timeline.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Account lookup at sign-in
--
-- When a password is being checked no session exists yet: the application role
-- is `anonymous` and RLS forbids it from reading `app_user`.
--
-- Rather than opening an owner connection from an HTTP route, we expose one
-- narrow SECURITY DEFINER function: it returns a single row, for one address,
-- and nothing else. The application role gains no general read access to the
-- table.
--
-- `search_path` is pinned: without it a hostile schema placed first on the
-- path could hijack a function that runs with the owner's rights.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.lookup_login(p_email text)
RETURNS TABLE (
  id uuid,
  email text,
  full_name text,
  job_title text,
  role text,
  password_hash text,
  must_change_password boolean,
  is_active boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT u.id, u.email, u.full_name, u.job_title, u.role::text,
         u.password_hash, u.must_change_password, u.is_active
    FROM app_user u
   WHERE lower(u.email) = lower(trim(p_email))
   LIMIT 1;
$$;
--> statement-breakpoint

-- Nobody may call it by default; the application role is granted EXECUTE in
-- scripts/apply-grants.ts along with the rest of its privileges.
REVOKE ALL ON FUNCTION app.lookup_login(text) FROM PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Password change
--
-- A member must be able to change THEIR OWN password. The `app_user` UPDATE
-- policy already lets them edit their own row, but it would also let them
-- rewrite another account's `password_hash` if application code targeted the
-- wrong row. This function settles it: it only ever writes to the id of the
-- current session.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.set_own_password(p_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid := app.current_user_id();
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Aucune session : changement de mot de passe refusé'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_hash IS NULL OR length(p_hash) < 20 THEN
    RAISE EXCEPTION 'Empreinte de mot de passe invalide'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE app_user
     SET password_hash = p_hash,
         must_change_password = false
   WHERE id = v_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.set_own_password(text) FROM PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Automatic timestamps on the new tables
-- -----------------------------------------------------------------------------

CREATE TRIGGER contact_touch_updated_at
  BEFORE UPDATE ON "contact"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER interaction_touch_updated_at
  BEFORE UPDATE ON "interaction"
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Integrity checks
-- -----------------------------------------------------------------------------

ALTER TABLE "contact"
  ADD CONSTRAINT contact_name_not_empty CHECK (length(trim("full_name")) > 0);
--> statement-breakpoint

ALTER TABLE "contact"
  ADD CONSTRAINT contact_email_shape
  CHECK ("email" IS NULL OR "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
--> statement-breakpoint

ALTER TABLE "interaction"
  ADD CONSTRAINT interaction_title_not_empty CHECK (length(trim("title")) > 0);
--> statement-breakpoint

-- An interaction is not recorded in the future: the timeline is a history,
-- not a calendar.
ALTER TABLE "interaction"
  ADD CONSTRAINT interaction_not_in_future
  CHECK ("occurred_at" <= now() + interval '1 day');
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. Row Level Security
--
-- The whole team works one client at a time: contacts and timeline are visible
-- to everyone. What is fenced off is the money (steps 3 and 5), not the
-- relationship.
-- -----------------------------------------------------------------------------

ALTER TABLE "contact" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contact" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY contact_select ON "contact"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY contact_insert ON "contact"
  FOR INSERT WITH CHECK (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY contact_update ON "contact"
  FOR UPDATE USING (app.is_authenticated()) WITH CHECK (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY contact_delete ON "contact"
  FOR DELETE USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY contact_bootstrap ON "contact" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

ALTER TABLE "interaction" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "interaction" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY interaction_select ON "interaction"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint

-- An entry is only ever filed under your own name: `author_id` must be the
-- current session. Stops anyone signing a write-up as a colleague.
CREATE POLICY interaction_insert ON "interaction"
  FOR INSERT WITH CHECK (app.is_authenticated() AND "author_id" = app.current_user_id());
--> statement-breakpoint

-- Everyone corrects their own entries; management can correct the whole timeline.
CREATE POLICY interaction_update ON "interaction"
  FOR UPDATE
  USING (app.is_admin() OR "author_id" = app.current_user_id())
  WITH CHECK (app.is_admin() OR "author_id" = app.current_user_id());
--> statement-breakpoint

CREATE POLICY interaction_delete ON "interaction"
  FOR DELETE USING (app.is_admin() OR "author_id" = app.current_user_id());
--> statement-breakpoint

CREATE POLICY interaction_bootstrap ON "interaction" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

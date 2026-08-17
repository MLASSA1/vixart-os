-- =============================================================================
-- 0021 — Managing the team: add, remove, change roles.
--
-- Two problems to solve.
--
-- (a) The existing UPDATE policy allowed a self-update only when the resulting
--     role was 'member'. Written when there were two roles, it silently blocks
--     the moderator from updating his own record now that there are three.
--     RLS cannot compare OLD to NEW, so the real rule — "you may edit yourself
--     but not your own role" — moves to a trigger and the policy is widened.
--
-- (b) Nothing stopped the last admin being demoted, deactivated or deleted.
--     That locks everyone out of Finance, invoices and account management with
--     no way back through the interface. The guard below makes it impossible.
-- =============================================================================

DROP POLICY IF EXISTS "app_user_update" ON "app_user";
--> statement-breakpoint

CREATE POLICY "app_user_update" ON "app_user"
  FOR UPDATE
  USING (app.is_admin() OR "id" = app.current_user_id())
  WITH CHECK (app.is_admin() OR "id" = app.current_user_id());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Who may change what, and the lockout guard.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.enforce_team_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_remaining integer;
BEGIN
  IF app.is_bootstrap() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- ---- Nobody edits their own role or their own access ---------------------
  IF TG_OP = 'UPDATE' AND OLD.id = app.current_user_id() THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'You cannot change your own role. Another administrator has to do it.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'You cannot deactivate your own account.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- ---- Only an admin changes someone else's role, access or address --------
  IF TG_OP = 'UPDATE' AND NOT app.is_admin() THEN
    IF NEW.role IS DISTINCT FROM OLD.role
    OR NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'Only an administrator can change a role, an address, or account access.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- ---- The last administrator cannot be removed ---------------------------
  -- Covers all three routes out: demotion, deactivation, deletion. Without it
  -- the agency can lock itself out of Finance and invoicing entirely, with no
  -- way back except a psql session on the server.
  IF (TG_OP = 'DELETE' AND OLD.role = 'admin' AND OLD.is_active)
  OR (TG_OP = 'UPDATE' AND OLD.role = 'admin' AND OLD.is_active
      AND (NEW.role IS DISTINCT FROM 'admin' OR NOT NEW.is_active)) THEN

    SELECT count(*) INTO v_remaining
      FROM app_user
     WHERE role = 'admin' AND is_active AND id <> OLD.id;

    IF v_remaining = 0 THEN
      RAISE EXCEPTION
        'This is the only active administrator. Promote someone else to administrator first, '
        'otherwise nobody can reach Finance, invoices or account management.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "app_user_team_rules"
  BEFORE UPDATE OR DELETE ON "app_user"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_team_rules();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Creating an account.
--
-- SECURITY DEFINER so the password hash is written in one place with one set of
-- rules, rather than trusting every future caller to remember
-- must_change_password. A new account always starts needing a password change:
-- whoever created it knows the initial one.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.create_team_member(
  p_email text, p_full_name text, p_job_title text, p_role text, p_hash text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only an administrator can create an account.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('admin','moderator','member') THEN
    RAISE EXCEPTION 'Unknown role: %', p_role USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_hash IS NULL OR length(p_hash) < 20 THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO app_user (email, full_name, job_title, role, password_hash, must_change_password)
  VALUES (lower(trim(p_email)), trim(p_full_name),
          nullif(trim(coalesce(p_job_title,'')), ''), p_role, p_hash, true)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.create_team_member(text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Resetting someone else's password, for the day a member is locked out.
-- Always forces a change on next sign-in: the admin who set it knows it.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.admin_reset_password(p_user_id uuid, p_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can reset a password.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_hash IS NULL OR length(p_hash) < 20 THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE app_user
     SET password_hash = p_hash, must_change_password = true
   WHERE id = p_user_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.admin_reset_password(uuid, text) FROM PUBLIC;

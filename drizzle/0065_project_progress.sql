-- =============================================================================
-- 0065 — How far along a project is, without saying what the work was.
--
-- A client should be able to see that their film is two thirds done. They
-- should not see the task list it was counted from: those titles are written
-- by the team for the team. They name people. They say "redo, client hated
-- it". They are the reason `task` is not in the client role's grants at all.
--
-- So the count is computed inside the database and only the count comes out.
--
-- SECURITY DEFINER, because the caller genuinely cannot read `task` — and
-- therefore GUARDED, because a definer function that takes an id is a way to
-- ask questions about rows you were never shown. Without the check below, a
-- client could walk project ids and learn how much work every other client of
-- the agency has commissioned and how much of it is finished.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.project_progress(p_project uuid)
RETURNS TABLE (done integer, total integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed boolean;
BEGIN
  SELECT
    -- Staff: any project, because they can already open the task list itself.
    (app.current_user_id() IS NOT NULL AND app.is_real_person()
       AND EXISTS (SELECT 1 FROM project WHERE id = p_project))
    OR
    -- A client: their own company's projects and no others. The company is
    -- derived (0064), so this cannot be widened from the portal.
    (app.is_client() AND EXISTS (
       SELECT 1 FROM project
        WHERE id = p_project AND company_id = app.current_client_company()))
  INTO allowed;

  IF NOT allowed THEN
    -- Zeros, not an error: a refusal that looks different from an empty
    -- project is itself an answer about a project you may not see.
    done := 0; total := 0; RETURN NEXT; RETURN;
  END IF;

  SELECT count(*) FILTER (WHERE t.status = 'completed')::int, count(*)::int
    INTO done, total
    FROM task t
   WHERE t.project_id = p_project;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION app.project_progress(uuid) IS
  'Completed tasks and total, for one project. SECURITY DEFINER because the '
  'client role cannot read task at all, and guarded because a definer that '
  'takes an id is a way to ask about rows you were never shown.';

REVOKE ALL ON FUNCTION app.project_progress(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_progress(uuid) TO vixart_app, vixart_client;

-- -----------------------------------------------------------------------------
-- A client chooses their own password
--
-- Mirrors `app.set_own_password` for staff, and for the same reason: the
-- client role has no UPDATE on `client_account` and must not have one. An
-- UPDATE grant on that table is a grant on `is_active` and on everybody's
-- `password_hash`, and the column list is not the part anybody checks later.
--
-- Guarded by its own narrowness: it writes WHERE contact_id =
-- app.current_client_contact(), which is the session's own id. There is no
-- argument naming a row, so there is no row to aim it at.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.set_own_client_password(p_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_contact uuid := app.current_client_contact();
BEGIN
  IF v_contact IS NULL THEN
    RAISE EXCEPTION 'No client session: password change refused'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_hash IS NULL OR length(p_hash) < 20 THEN
    RAISE EXCEPTION 'Invalid password hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE client_account
     SET password_hash = p_hash,
         must_change_password = false,
         -- The generated password is gone, so its expiry has nothing left to
         -- limit. Leaving it set would expire a password they chose.
         initial_password_expires_at = NULL,
         updated_at = now()
   WHERE contact_id = v_contact
     AND is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That account is closed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

COMMENT ON FUNCTION app.set_own_client_password(text) IS
  'A client sets their own password. Writes only WHERE contact_id = the '
  'session''s own contact, which is a tighter guard than a role check.';

REVOKE ALL ON FUNCTION app.set_own_client_password(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_own_client_password(text) TO vixart_client;

-- The portal records the sign-in for the same reason and in the same way.
CREATE OR REPLACE FUNCTION app.record_client_sign_in()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_contact uuid := app.current_client_contact();
BEGIN
  IF v_contact IS NULL THEN RETURN; END IF;
  UPDATE client_account SET last_sign_in_at = now() WHERE contact_id = v_contact;
END;
$$;

REVOKE ALL ON FUNCTION app.record_client_sign_in() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_client_sign_in() TO vixart_client;

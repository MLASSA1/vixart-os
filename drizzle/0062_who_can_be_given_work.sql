-- =============================================================================
-- 0062 — Who can be given work.
--
-- `app.team_directory` exposes a name and a role and nothing else — it exists
-- so that a page can list the team without going near `app_user`, where the
-- password hashes are. What it does NOT expose is whether a row is a person.
--
-- Two of its columns decide that: `is_assignable` and `is_service_account`.
-- Le Chef and Le Comptable are neither — they are automation accounts that
-- cannot sign in. So every caller that wanted a list of PEOPLE had to reach
-- past the view and back into `app_user` to ask:
--
--     AND EXISTS (SELECT 1 FROM app_user a
--                  WHERE a.id = u.id AND a.is_assignable AND NOT a.is_service_account)
--
-- Three places wrote that. Two forgot — so the Tasks page offered "Le Chef" in
-- its assign-to list, and the Schedule drew a column for an account that
-- cannot log in to see it. A task assigned there is not late, it is lost: no
-- inbox, no sign-in, and the twenty-four-hour nudge would mail nobody.
--
-- The rule therefore moves into the view, where there is one of it, and the
-- callers stop reconstructing it.
--
-- AND THE DATABASE REFUSES IT. A list is a convenience; it is not a rule. The
-- browser sends an id, and the id it sends is whatever was in the form. So the
-- guard is here as well, where it cannot be got round by a page that forgets
-- to filter — which is precisely what both of those pages had already done.
-- =============================================================================

CREATE OR REPLACE VIEW app.team_directory
WITH (security_barrier = true) AS
  SELECT id, full_name, job_title, role, is_active,
         -- Named for what a caller actually wants to ask. `is_assignable` on
         -- its own reads like a scheduling preference; this reads like the
         -- question: can work be given to this row?
         (is_assignable AND NOT is_service_account) AS is_person
    FROM app_user;

COMMENT ON VIEW app.team_directory IS
  'The team, without the password hashes. `is_person` is false for automation '
  'accounts: nobody signs in as one, so nothing can be assigned to one.';

-- -----------------------------------------------------------------------------
-- Work goes to people
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.enforce_task_assignee()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Unassigned is allowed and ordinary: a task raised before anyone has
  -- picked it up.
  IF NEW.assignee_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- SECURITY INVOKER: `app_user_select` already admits every signed-in person
  -- to the directory, so this needs no privilege of its own — and a definer
  -- function is a hole to be justified, not a default.
  IF NOT EXISTS (
    SELECT 1 FROM app_user u
     WHERE u.id = NEW.assignee_id
       AND u.is_active
       AND u.is_assignable
       AND NOT u.is_service_account
  ) THEN
    RAISE EXCEPTION 'That account cannot be given work.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.enforce_task_assignee() IS
  'A task goes to somebody who can sign in and see it. Refuses service and '
  'deactivated accounts, whatever id the form submitted.';

DROP TRIGGER IF EXISTS task_assignee_is_a_person ON task;

CREATE TRIGGER task_assignee_is_a_person
  BEFORE INSERT OR UPDATE OF assignee_id ON task
  FOR EACH ROW
  EXECUTE FUNCTION app.enforce_task_assignee();

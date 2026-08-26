-- =============================================================================
-- 0030 — app.actor_name() must run as definer.
--
-- The third instance of one pattern, so it is worth naming.
--
-- A helper function reads `app_user`. It is SECURITY INVOKER, so it runs with
-- the caller's rights. Every agent role is deliberately denied `app_user` —
-- that is how `password_hash` is kept out of reach — so the helper fails for
-- exactly the callers it was meant to serve, and the failure surfaces far from
-- its cause: here, as "permission denied for table app_user" when the work
-- agent creates a task, because the activity trigger calls it.
--
--   0027  app.agent_user_id()      — same cause, found by the phase 1 tests
--   0028  app.work_agent_user_id() — written as definer, having learned it
--   0030  app.actor_name()         — this one, found by the phase 2 tests
--
-- Definer is right for all three: none takes an argument, each returns one
-- value about the current session, and there is no input to abuse. The general
-- rule for this codebase: a helper that reads `app_user` and is called from a
-- trigger or a policy must be SECURITY DEFINER with a pinned search_path.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.actor_name() RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT coalesce(
    (SELECT full_name FROM app_user WHERE id = app.current_user_id()),
    'System'
  );
$$;

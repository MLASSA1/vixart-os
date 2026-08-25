-- =============================================================================
-- 0027 — app.agent_user_id() must run as definer.
--
-- 0026 defined it SECURITY INVOKER, reading `app_user`. The agent role has no
-- grant on that table — deliberately, so it can never reach password_hash — so
-- calling the function failed with "permission denied for table app_user", and
-- the agent could not write even the draft it is supposed to be able to write.
--
-- The function is also referenced inside the RLS policies for `document`,
-- `document_line` and `finance_entry`, so this was not only an inconvenience:
-- the policy check itself could not evaluate.
--
-- SECURITY DEFINER with a pinned search_path is right here. The function takes
-- no argument and returns exactly one uuid for one hardcoded address; there is
-- no input to abuse and nothing else it can be made to reveal.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.agent_user_id() RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT id FROM app_user WHERE email = 'agent@vixart.local';
$$;

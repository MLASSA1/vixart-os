-- =============================================================================
-- 0008 — Let a moderator be authenticated.
--
-- `app.is_authenticated()` was written when the system had two roles and reads:
--
--     SELECT app.current_user_role() IN ('admin', 'member')
--
-- Adding 'moderator' in 0006 therefore locked Mohamed Amine out of every table
-- guarded by that helper — companies, contacts, timeline, projects, tasks — as
-- if he were an anonymous connection. The helper is the single place that
-- defines "signed in", so it is the single place that needs to change.
--
-- Written as a list rather than "not anonymous" on purpose: a role that is not
-- recognised should read as unauthenticated, not be trusted by default.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() IN ('admin', 'moderator', 'member');
$$;

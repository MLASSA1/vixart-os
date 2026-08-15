-- =============================================================================
-- 0004 — Bring the database's own error messages in line with the interface
--        language.
--
-- The interface moved from French to English. The message raised by the
-- fiscal-parameter guard is written in migration 0001, which has already run on
-- the live database: editing that file changes new installs only. This
-- migration replaces the function so an existing database says the same thing
-- as a fresh one.
--
-- Behaviour is unchanged — same guard, same ERRCODE, only the wording differs.
-- =============================================================================

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

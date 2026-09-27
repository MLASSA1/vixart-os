-- =============================================================================
-- 0074 — Dates a calendar can hold, and a sign-in that gets recorded.
--
-- Two findings from an audit of the running application.
--
-- ONE — A PROJECT DUE IN THE YEAR 87664.
--
-- "VIXART Brand OS" carried `due_date 87664-09-09` and `start_date 0753-04-04`.
-- Two typed dates, both wrong, on one record — a date field with no picker and
-- no bound will take anything PostgreSQL can store, and `date` can store the
-- year 87664 perfectly happily.
--
-- What it costs is not the display. Everything that reasons about deadlines —
-- the overdue queues, the attention page, the progress a client reads — treats
-- that project as never due and never started. It is silently outside every
-- warning the system produces, which is the opposite of what a deadline is for.
--
-- The dates are set to NULL rather than guessed. 87664 is probably a fumbled
-- 2026 and 0753 probably a fumbled 2025, and "probably" is not good enough to
-- write into a record that drives client-facing progress. Amin sets them.
--
-- TWO — THE CLIENT SIGN-IN THAT COULD NEVER BE RECORDED.
--
-- The Client portal page reports "Signs in: never" and "0 signed in at least
-- once" for accounts that have demonstrably signed in. `last_sign_in_at` is
-- never written, and the reason is a neat little circle:
-- `app.record_client_sign_in()` reads `app.current_client_contact()` — the
-- session identity — and sign-in is the one moment when there is no session
-- identity yet. It returns immediately, every time. Nothing ever called it,
-- which is why nobody noticed the function it would have called does nothing.
--
-- So it takes the contact instead. A definer with an id argument is a pattern
-- this schema is careful about, and here the exposure is bounded to the width of
-- what it writes: one timestamp, set to now(), on an account that is active,
-- with nothing returned to the caller. The client role cannot SELECT
-- `client_account` at all, so it cannot read back what it wrote.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The bad row, before the constraint that would refuse it
-- -----------------------------------------------------------------------------

UPDATE project
   SET start_date = NULL,
       due_date   = NULL
 WHERE due_date   > DATE '2100-01-01' OR due_date   < DATE '2000-01-01'
    OR start_date > DATE '2100-01-01' OR start_date < DATE '2000-01-01';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Bounds, so the next mistyped year is refused rather than stored
-- -----------------------------------------------------------------------------

/*
 * A century either side of now, which is not a judgement about the business —
 * it is the range in which a date is a DEADLINE rather than a typing accident.
 * Narrow enough to catch a slipped digit, wide enough that nothing anybody
 * legitimately enters is ever refused.
 */
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_dates_plausible;
--> statement-breakpoint
ALTER TABLE project ADD CONSTRAINT project_dates_plausible CHECK (
  (start_date IS NULL OR start_date BETWEEN DATE '2000-01-01' AND DATE '2100-01-01')
  AND
  (due_date   IS NULL OR due_date   BETWEEN DATE '2000-01-01' AND DATE '2100-01-01')
);
--> statement-breakpoint

ALTER TABLE task DROP CONSTRAINT IF EXISTS task_due_date_plausible;
--> statement-breakpoint
ALTER TABLE task ADD CONSTRAINT task_due_date_plausible CHECK (
  due_date IS NULL OR due_date BETWEEN DATE '2000-01-01' AND DATE '2100-01-01'
);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- A sign-in that can actually be recorded
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS app.record_client_sign_in();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.record_client_sign_in(p_contact uuid)
RETURNS void
LANGUAGE plpgsql
-- DEFINER because the client role has no UPDATE on `client_account` and must
-- not be given one: that grant would cover `is_active` and every password hash
-- in the table.
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  /*
   * Narrow on purpose. It sets one column to now() — not to a value the caller
   * chose — on an account that is active, and returns nothing. The worst a
   * caller can do with an id it should not have is record a sign-in that did not
   * happen, which is a nuisance in a report and not a disclosure: the client
   * role cannot read this table back.
   */
  UPDATE client_account
     SET last_sign_in_at = now()
   WHERE contact_id = p_contact
     AND is_active;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.record_client_sign_in(uuid) IS
  'Stamps a client''s last sign-in. Takes the contact because sign-in happens '
  'BEFORE any session identity exists — the previous no-argument version read '
  'app.current_client_contact() and so did nothing, ever. EXEMPT from the '
  'definer-caller check: writes one timestamp to now() on an active account and '
  'returns no data.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.record_client_sign_in(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.record_client_sign_in(uuid) TO vixart_client;

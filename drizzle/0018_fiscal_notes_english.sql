-- =============================================================================
-- 0018 — Translate the seeded tax-parameter notes, and give fiscal_rate the
--        same bootstrap door as every other guard.
--
-- Same story as 0005 and 0010: these rows were written by the seed before the
-- interface was converted to English, and the seed is idempotent so it never
-- rewrote them. The System screen was still showing French.
--
-- `fiscal_rate` is immutable by trigger, with no exception — so the only way to
-- correct seed text was DISABLE TRIGGER, which is exactly the loaded gun that
-- left invoice immutability switched off during development (see 0017). The
-- door goes in first; then the text is fixed through it.
--
-- To be clear about what the door does NOT permit: it is opened only by
-- `app.bootstrap`, which nothing but the migration and seed scripts sets. A
-- signed-in session, admin included, still cannot rewrite a rate version.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.forbid_fiscal_rate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'A tax parameter is versioned and immutable (key "%", in force from %). '
    'Insert a new version with a later effective_from date instead.',
    OLD.key, OLD.effective_from
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

DO $$
DECLARE n integer := 0; c integer;
BEGIN
  PERFORM set_config('app.bootstrap', 'on', true);

  UPDATE fiscal_rate
     SET note = 'Standard VAT — advertising services (agency).'
   WHERE key = 'tva_standard'
     AND note = 'TVA de droit commun — prestations de publicité (agence).';
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  UPDATE fiscal_rate
     SET note = 'TO BE SET BY THE FOUNDER (art. 117 bis CGI). Kept at zero until '
                'the accountant confirms the applicable rate. Do not guess: add a '
                'new dated version rather than editing this one.'
   WHERE key = 'retenue_source_tva'
     AND note LIKE 'À DÉFINIR PAR LE GÉRANT%';
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  RAISE NOTICE '[0018] % seeded note(s) translated', n;
END $$;

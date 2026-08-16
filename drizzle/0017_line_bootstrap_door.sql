-- =============================================================================
-- 0017 — Give document lines the same bootstrap door as every other guard,
--        so nobody ever has a reason to DISABLE the trigger.
--
-- Why this exists: deleting a document cascades to its lines, and
-- document_line_immutable raises on DELETE when the parent is issued. The only
-- way to clean up (tests, maintenance, a bad import) was
-- `ALTER TABLE ... DISABLE TRIGGER`. That is a loaded gun: a script that throws
-- between DISABLE and ENABLE leaves invoice immutability switched OFF on a live
-- database, silently. That happened here during testing.
--
-- Every other guard in this schema already honours `app.bootstrap`, which only
-- the migration and seed scripts set. Lines now do too, and nothing needs to
-- touch the trigger switch again.
--
-- Note what is deliberately NOT changed: `document_immutable` (BEFORE UPDATE)
-- keeps no escape hatch. Rewriting the figures on an issued invoice has no
-- legitimate maintenance case — a restore loads rows by INSERT, not UPDATE.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.enforce_document_line_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_number text;
  v_doc    uuid;
BEGIN
  -- The named door, used only by migration and seed scripts.
  IF app.is_bootstrap() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_doc := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  SELECT status, number INTO v_status, v_number FROM document WHERE id = v_doc;

  -- The parent is already gone (cascade from a permitted delete): nothing to guard.
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status IS DISTINCT FROM 'brouillon' THEN
    RAISE EXCEPTION
      'Document % was issued; its lines cannot be changed. Issue a credit note instead.',
      coalesce(v_number, '(unnumbered)')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

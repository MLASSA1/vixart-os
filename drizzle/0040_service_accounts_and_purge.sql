-- VIXART OS — decouple the flag from the credential, and make the purge real.
--
-- Two corrections to 0039, both raised in review and both right.
--
-- 1. app_user_service_not_assignable keyed an AUTHORIZATION flag on a
--    CREDENTIAL string:
--
--      CHECK (password_hash NOT LIKE 'NO-LOGIN%' OR NOT is_assignable)
--
--    It does not have the failure described — the implication runs one way, so
--    a real person can still be marked unassignable the day they leave, and
--    that was verified before changing anything. The problem is the coupling
--    itself. "Is this a service account" is a fact about the account, not
--    about the bytes in its password column, and the day that sentinel string
--    changes the constraint stops protecting anything without a word.
--
-- 2. The purge lived in a DO block inside a migration. It ran once, against
--    zero rows, and can never run again. Hand-crossing the RESTRICT edges on
--    finance_entry, document_payment and corrects_id is exactly the logic that
--    needs exercising, and it had never executed against a single row. It is a
--    function now, so it can be called, tested, and re-run.

-- ===========================================================================
-- 1. A service account says so about itself.
-- ===========================================================================
ALTER TABLE app_user
  ADD COLUMN is_service_account boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app_user.is_service_account IS
  'True for accounts that exist only to own historical rows — the retired '
  'agent identities. Not a person: never offered work, never listed as team, '
  'and cannot authenticate. Independent of password_hash, which is a '
  'credential and has no business deciding authorization.';

UPDATE app_user SET is_service_account = true WHERE password_hash LIKE 'NO-LOGIN%';

ALTER TABLE app_user DROP CONSTRAINT app_user_service_not_assignable;

-- The rule, now stated about what the account IS.
ALTER TABLE app_user
  ADD CONSTRAINT app_user_service_not_assignable
  CHECK (NOT is_service_account OR NOT is_assignable);

-- A service account must never hold a usable credential. This is the sentinel's
-- actual job, and as a constraint it is checked rather than assumed.
ALTER TABLE app_user
  ADD CONSTRAINT app_user_service_cannot_login
  CHECK (NOT is_service_account OR password_hash LIKE 'NO-LOGIN%');

-- ===========================================================================
-- 2. The purge, as something that can be run and therefore tested.
-- ===========================================================================
CREATE FUNCTION app.purge_probe_companies() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_companies uuid[];
  v_documents uuid[];
  v_projects  uuid[];
  v_tasks     uuid[];
  v_n integer;
BEGIN
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can purge test data.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 'ZZZ ' with the trailing space. A real client could be ZZZDesign; none
  -- will be 'ZZZ Design'.
  SELECT coalesce(array_agg(id), '{}') INTO v_companies
    FROM company WHERE name LIKE 'ZZZ %';

  IF array_length(v_companies, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO v_documents
    FROM document WHERE company_id = ANY(v_companies);
  SELECT coalesce(array_agg(id), '{}') INTO v_projects
    FROM project WHERE company_id = ANY(v_companies);
  SELECT coalesce(array_agg(id), '{}') INTO v_tasks
    FROM task WHERE project_id = ANY(v_projects);

  -- Ledger lines RESTRICT both document and document_payment.
  DELETE FROM finance_entry
   WHERE company_id = ANY(v_companies) OR document_id = ANY(v_documents);

  -- Payments RESTRICT their document, and their own delete guard refuses once
  -- an invoice is settled. Lifted for this statement and restored immediately;
  -- the caller's transaction means a failure anywhere leaves it enabled.
  ALTER TABLE document_payment DISABLE TRIGGER payment_delete_rules;
  DELETE FROM document_payment WHERE document_id = ANY(v_documents);
  ALTER TABLE document_payment ENABLE TRIGGER payment_delete_rules;

  -- A credit note RESTRICTs the invoice it corrects; break the link so the
  -- order of deletion within the set stops mattering.
  UPDATE document SET corrects_id = NULL
   WHERE corrects_id = ANY(v_documents) AND id = ANY(v_documents);

  -- Polymorphic children: no foreign key carries these away.
  DELETE FROM attachment
   WHERE (entity_type = 'company'  AND entity_id = ANY(v_companies))
      OR (entity_type = 'document' AND entity_id = ANY(v_documents))
      OR (entity_type = 'project'  AND entity_id = ANY(v_projects))
      OR (entity_type = 'task'     AND entity_id = ANY(v_tasks));

  DELETE FROM comment
   WHERE (entity_type = 'company' AND entity_id = ANY(v_companies))
      OR (entity_type = 'project' AND entity_id = ANY(v_projects))
      OR (entity_type = 'task'    AND entity_id = ANY(v_tasks));

  -- document_line cascades from document. deal_line from deal, task from
  -- project, contact and interaction from company.
  DELETE FROM document WHERE id = ANY(v_documents);
  DELETE FROM company  WHERE id = ANY(v_companies);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- activity is deliberately untouched: append-only, and the record of what
  -- happened to things that no longer exist.
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION app.purge_probe_companies() IS
  'Removes companies named ZZZ <…> and everything that hangs off them. '
  'Returns the number of companies removed; 0 and harmless when there are '
  'none. Never touches activity.';

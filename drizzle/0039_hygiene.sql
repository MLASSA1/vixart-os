-- VIXART OS — Phase 1 hygiene: purge test probes, retire the ghost accounts.
--
-- Two unrelated jobs, both small, both about the system telling the truth
-- about itself.

-- ===========================================================================
-- 1. Test probe rows.
--
-- Integration tests create companies named 'ZZZ <something> probe' and clean
-- up after themselves. A run that crashes between the two leaves wreckage,
-- and wreckage in a client list is worse than useless — it is a client list
-- you stop trusting.
--
-- On this database today the count is zero: the suite purges on setup as well
-- as teardown, so a crashed run is cleaned by the next one. This migration is
-- therefore a no-op here, deliberately, and exists so the cleanup is
-- reproducible rather than something someone remembers to do by hand.
--
-- The prefix is 'ZZZ ' WITH the trailing space, matched with LIKE against a
-- literal. A real client could plausibly be called ZZZDesign; none will be
-- called 'ZZZ Design'. Nothing here touches a row that does not match.
--
-- `activity` is deliberately untouched. It is append-only and it is the record
-- of what happened, including to things that no longer exist.
-- ===========================================================================

DO $$
DECLARE
  v_companies uuid[];
  v_documents uuid[];
  v_projects  uuid[];
  v_tasks     uuid[];
  v_deals     uuid[];
  v_n integer;
BEGIN
  SELECT coalesce(array_agg(id), '{}') INTO v_companies
    FROM company WHERE name LIKE 'ZZZ %';

  IF array_length(v_companies, 1) IS NULL THEN
    RAISE NOTICE 'hygiene: no probe companies — nothing to purge';
    RETURN;
  END IF;

  RAISE NOTICE 'hygiene: purging % probe compan(ies)', array_length(v_companies, 1);

  SELECT coalesce(array_agg(id), '{}') INTO v_documents
    FROM document WHERE company_id = ANY(v_companies);
  SELECT coalesce(array_agg(id), '{}') INTO v_projects
    FROM project WHERE company_id = ANY(v_companies);
  SELECT coalesce(array_agg(id), '{}') INTO v_deals
    FROM deal WHERE company_id = ANY(v_companies);
  SELECT coalesce(array_agg(id), '{}') INTO v_tasks
    FROM task WHERE project_id = ANY(v_projects);

  -- Ledger lines first: they RESTRICT both document and document_payment.
  DELETE FROM finance_entry
   WHERE company_id = ANY(v_companies) OR document_id = ANY(v_documents);

  -- Payments RESTRICT their document. The append-only guard on payments is a
  -- BEFORE DELETE trigger that refuses once an invoice is settled, so it is
  -- lifted for this statement and restored immediately — inside the same
  -- transaction, so a failure anywhere leaves it enabled.
  ALTER TABLE document_payment DISABLE TRIGGER payment_delete_rules;
  DELETE FROM document_payment WHERE document_id = ANY(v_documents);
  ALTER TABLE document_payment ENABLE TRIGGER payment_delete_rules;

  -- A credit note RESTRICTs the invoice it corrects. Break the link first so
  -- the order of deletion within the set stops mattering.
  UPDATE document SET corrects_id = NULL
   WHERE corrects_id = ANY(v_documents) AND id = ANY(v_documents);

  -- Files and notes hang off entities polymorphically, with no foreign key to
  -- carry them away. Left behind they become rows pointing at nothing.
  DELETE FROM attachment
   WHERE (entity_type = 'company'  AND entity_id = ANY(v_companies))
      OR (entity_type = 'document' AND entity_id = ANY(v_documents))
      OR (entity_type = 'project'  AND entity_id = ANY(v_projects))
      OR (entity_type = 'task'     AND entity_id = ANY(v_tasks));

  DELETE FROM comment
   WHERE (entity_type = 'company' AND entity_id = ANY(v_companies))
      OR (entity_type = 'project' AND entity_id = ANY(v_projects))
      OR (entity_type = 'task'    AND entity_id = ANY(v_tasks));

  -- document_line cascades from document; deal_line from deal; task from
  -- project; contact and interaction from company.
  DELETE FROM document WHERE id = ANY(v_documents);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'hygiene: % document(s) removed', v_n;

  DELETE FROM company WHERE id = ANY(v_companies);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'hygiene: % compan(ies) removed, cascading deals and projects', v_n;
END
$$;

-- ===========================================================================
-- 2. The ghost accounts.
--
-- agent@vixart.local (Le Comptable) and chef@vixart.local (Le Chef) were the
-- two agent service accounts. The agents were removed in 0032; the accounts
-- had to stay, because `activity` is append-only and chef@vixart.local is the
-- actor on rows already in it.
--
-- They cannot authenticate — their password_hash is the literal NO-LOGIN
-- sentinel, which no bcrypt comparison can match. But they are is_active and
-- role='member', so every people picker in the application still offers them:
-- project lead, task assignee, equipment holder, and the /team roster. A task
-- can be assigned to a piece of software that was deleted a fortnight ago.
--
-- A new flag rather than is_active=false, deliberately. is_active means "works
-- here and has stopped" — a person who left. These were never people, and
-- marking them inactive would put two departed staff on the Team screen who
-- never existed. is_assignable says the true thing: not a person, do not offer.
-- ===========================================================================

ALTER TABLE app_user
  ADD COLUMN is_assignable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN app_user.is_assignable IS
  'False for service accounts that exist only to own historical rows. They are '
  'never offered in a people picker and never listed as team. Distinct from '
  'is_active, which describes a PERSON who has stopped working here.';

UPDATE app_user
   SET is_assignable = false
 WHERE password_hash LIKE 'NO-LOGIN%';

-- Anything that cannot log in cannot be given work. Stated as a constraint so
-- a future service account inherits the rule instead of relying on the UPDATE
-- above having been remembered.
ALTER TABLE app_user
  ADD CONSTRAINT app_user_service_not_assignable
  CHECK (password_hash NOT LIKE 'NO-LOGIN%' OR NOT is_assignable);

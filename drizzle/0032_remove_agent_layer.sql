-- VIXART OS — remove the agent layer.
--
-- The two agents are gone: using them costs money per question, and the app
-- does not need them to do its job. This migration removes their side of the
-- database. It is deliberately thorough, because the dangerous half of an
-- agent is not its code — it is the grants and policies that let a login act.
-- Leaving those behind would mean a role that can still read the books sitting
-- in the cluster with nothing watching it.
--
-- What is NOT removed, and why:
--
--   declaration, effort_log, capacity — empty tables, no agent dependency once
--   the policies below are gone. The fiscal calendar and the effort log are
--   ordinary business records that a later screen could surface. Dropping a
--   table is destructive and nothing is gained by it today.
--
--   agent@vixart.local and chef@vixart.local — the activity log is append-only
--   by design, and chef@vixart.local is the actor on rows already in it.
--   Deleting the account would either break that reference or require
--   rewriting history, and the whole point of an append-only log is that it
--   cannot be tidied afterwards. The accounts hold NO-LOGIN in place of a
--   password hash and cannot authenticate; the Postgres roles they went with
--   are dropped in scripts/apply-grants.ts.

-- ---------------------------------------------------------------------------
-- 1. The policies. Generated from pg_policies, not typed from memory.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS activity_agent_insert ON activity;
DROP POLICY IF EXISTS capacity_work_agent_read ON capacity;
DROP POLICY IF EXISTS comment_work_agent_insert ON comment;
DROP POLICY IF EXISTS comment_work_agent_read ON comment;
DROP POLICY IF EXISTS company_agent_read ON company;
DROP POLICY IF EXISTS company_work_agent_read ON company;
DROP POLICY IF EXISTS contact_agent_read ON contact;
DROP POLICY IF EXISTS deal_agent_read ON deal;
DROP POLICY IF EXISTS deal_line_agent_read ON deal_line;
DROP POLICY IF EXISTS declaration_agent_read ON declaration;
DROP POLICY IF EXISTS document_agent_draft_insert ON document;
DROP POLICY IF EXISTS document_agent_read ON document;
DROP POLICY IF EXISTS document_line_agent_insert ON document_line;
DROP POLICY IF EXISTS document_line_agent_read ON document_line;
DROP POLICY IF EXISTS effort_log_agent_read ON effort_log;
DROP POLICY IF EXISTS effort_work_agent_read ON effort_log;
DROP POLICY IF EXISTS equipment_agent_read ON equipment;
DROP POLICY IF EXISTS finance_agent_insert ON finance_entry;
DROP POLICY IF EXISTS finance_agent_read ON finance_entry;
DROP POLICY IF EXISTS fiscal_rate_agent_read ON fiscal_rate;
DROP POLICY IF EXISTS project_agent_read ON project;
DROP POLICY IF EXISTS project_work_agent_read ON project;
DROP POLICY IF EXISTS recurring_agent_read ON recurring_entry;
DROP POLICY IF EXISTS service_agent_read ON service;
DROP POLICY IF EXISTS service_price_agent_read ON service_price;
DROP POLICY IF EXISTS task_agent_read ON task;
DROP POLICY IF EXISTS task_work_agent_insert ON task;
DROP POLICY IF EXISTS task_work_agent_read ON task;
DROP POLICY IF EXISTS task_work_agent_update ON task;

-- ---------------------------------------------------------------------------
-- 2. The three functions that branched on an agent, restored to human-only.
--
-- Each is rewritten in full rather than patched, so what runs is what this
-- file says.
-- ---------------------------------------------------------------------------

-- A task is created by a moderator, or by start-up. There is no third case.
CREATE OR REPLACE FUNCTION app.enforce_task_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (app.is_bootstrap() OR app.is_moderator()) THEN
    RAISE EXCEPTION 'Only a moderator can create and assign tasks.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Whoever opens it, a task starts unstarted and unsigned.
  NEW.status          := COALESCE(NULLIF(NEW.status, 'completed'), 'todo');
  NEW.completed_at    := NULL;
  NEW.completed_by_id := NULL;
  RETURN NEW;
END;
$$;

-- Two paths again, as before the agent existed: a moderator, and the person
-- the task belongs to. The member's half is unchanged — they move status and
-- nothing else, and completion is the moderator's to give.
CREATE OR REPLACE FUNCTION app.enforce_task_signoff() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() OR app.is_moderator() THEN
    IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
      NEW.completed_at    := now();
      NEW.completed_by_id := COALESCE(NEW.completed_by_id, app.current_user_id());
    ELSIF NEW.status <> 'completed' THEN
      NEW.completed_at    := NULL;
      NEW.completed_by_id := NULL;
    END IF;

    IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
      NEW.submitted_at := COALESCE(NEW.submitted_at, now());
    END IF;

    RETURN NEW;
  END IF;

  -- ---- a plain member ----

  IF OLD.assignee_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'You can only update a task assigned to you.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = 'completed' THEN
    RAISE EXCEPTION
      'Only a moderator can mark a task completed. Submit it for review instead.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'This task was signed off by a moderator and cannot be reopened here.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.title       IS DISTINCT FROM OLD.title
  OR NEW.description IS DISTINCT FROM OLD.description
  OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
  OR NEW.priority    IS DISTINCT FROM OLD.priority
  OR NEW.due_date    IS DISTINCT FROM OLD.due_date
  OR NEW.project_id  IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'You can change the status of your task, not its definition.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    NEW.submitted_at := now();
  END IF;

  NEW.completed_at    := OLD.completed_at;
  NEW.completed_by_id := OLD.completed_by_id;
  RETURN NEW;
END;
$$;

-- issue_document, with the agent guard removed and every other line taken
-- verbatim from the live definition.
CREATE OR REPLACE FUNCTION app.issue_document(p_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d document%ROWTYPE; c company%ROWTYPE;
  v_lines integer; v_subtotal bigint; v_discount bigint; v_excl bigint;
  v_vat bigint; v_incl bigint; v_withheld bigint;
  v_number text; v_seq integer; v_year integer;
BEGIN
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can issue a document.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO d FROM document WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found.' USING ERRCODE = 'no_data_found';
  END IF;

  IF d.status <> 'brouillon' THEN
    RAISE EXCEPTION 'This document was already issued as %. Issue a credit note to correct it.', d.number
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_lines FROM document_line WHERE document_id = p_id;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'A document cannot be issued with no lines.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum((unit_price_centimes * quantity_millis + 500) / 1000), 0)
    INTO v_subtotal FROM document_line WHERE document_id = p_id;

  v_discount := least(d.discount_centimes, v_subtotal);
  v_excl     := v_subtotal - v_discount;
  v_vat      := (v_excl * d.vat_rate_bp + 5000) / 10000;
  v_incl     := v_excl + v_vat;
  v_withheld := CASE WHEN d.withholding
                     THEN (v_vat * d.withholding_rate_bp + 5000) / 10000
                     ELSE 0 END;

  SELECT * INTO c FROM company WHERE id = d.company_id;

  v_year := extract(year FROM coalesce(d.issue_date, current_date))::integer;
  SELECT n.number, n.seq INTO v_number, v_seq
    FROM app.next_document_number(d.doc_type, v_year) n;

  UPDATE document SET
    status = 'emis', number = v_number, number_year = v_year, number_seq = v_seq,
    issue_date = coalesce(issue_date, current_date),
    total_excl_vat = v_excl, total_vat = v_vat, total_incl_vat = v_incl,
    withheld = v_withheld, net_to_collect = v_incl - v_withheld,
    client_name = c.name, client_legal_name = c.legal_name,
    client_ice = c.ice, client_if = c.identifiant_fiscal,
    client_address = concat_ws(', ', c.address_line, c.city)
  WHERE id = p_id;

  RETURN v_number;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The helpers themselves. Dropped last: the policies and functions above
--    called them, and PostgreSQL would refuse while a dependency stood.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app.is_agent();
DROP FUNCTION IF EXISTS app.agent_user_id();
DROP FUNCTION IF EXISTS app.is_work_agent();
DROP FUNCTION IF EXISTS app.work_agent_user_id();

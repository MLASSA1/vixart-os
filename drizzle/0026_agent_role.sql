-- =============================================================================
-- 0026 — The agent's PostgreSQL role.
--
-- A prompt is a suggestion; a grant is a wall. Whatever the model decides to do,
-- `vixart_agent` physically cannot issue an invoice number, edit a fiscal rate,
-- or delete a ledger line. That is a property of the connection, not of the
-- system prompt, and it survives prompt injection, a bad tool definition and a
-- future refactor equally.
--
-- What it may do:
--   SELECT  the business tables it reports on
--   INSERT  a document ONLY as a draft, and its lines
--   INSERT  a hand-entered finance line under its own service account
--
-- What it may never do:
--   UPDATE or DELETE anything, anywhere
--   touch fiscal_rate or service_price at all
--   read password_hash
--   call app.issue_document(), which is what assigns a number
-- =============================================================================

-- The role itself is created by scripts/apply-grants.ts, which owns role
-- creation and passwords (they are cluster-level and not in a dump). This
-- migration owns the *policies*, which are per-database and must be versioned.

-- -----------------------------------------------------------------------------
-- 1. Identity
--
-- The agent runs as a real, non-login service account so every row it writes is
-- attributable. `app.is_agent()` reads the session context exactly as the human
-- role checks do.
-- -----------------------------------------------------------------------------

INSERT INTO app_user (email, full_name, job_title, role, password_hash, is_active, must_change_password)
VALUES ('agent@vixart.local', 'Le Comptable', 'Finance agent', 'member',
        -- Not a bcrypt hash of anything: this account can never sign in.
        'NO-LOGIN-service-account-no-password-accepted', true, false)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.agent_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM app_user WHERE email = 'agent@vixart.local';
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_agent() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() = 'agent';
$$;
--> statement-breakpoint

-- The agent is NOT authenticated in the human sense. Every existing policy is
-- written against app.is_authenticated() / is_admin() / is_moderator(), and
-- none of those return true for it — so it starts with access to nothing and
-- each grant below is deliberate.

-- -----------------------------------------------------------------------------
-- 2. Read policies — one per table it reports on
-- -----------------------------------------------------------------------------

CREATE POLICY "company_agent_read"        ON "company"         FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "contact_agent_read"        ON "contact"         FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "deal_agent_read"           ON "deal"            FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "deal_line_agent_read"      ON "deal_line"       FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "project_agent_read"        ON "project"         FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "task_agent_read"           ON "task"            FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "effort_log_agent_read"     ON "effort_log"      FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "service_agent_read"        ON "service"         FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "service_price_agent_read"  ON "service_price"   FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "document_agent_read"       ON "document"        FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "document_line_agent_read"  ON "document_line"   FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "finance_agent_read"        ON "finance_entry"   FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "recurring_agent_read"      ON "recurring_entry" FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "declaration_agent_read"    ON "declaration"     FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "fiscal_rate_agent_read"    ON "fiscal_rate"     FOR SELECT USING (app.is_agent());
--> statement-breakpoint
CREATE POLICY "equipment_agent_read"      ON "equipment"       FOR SELECT USING (app.is_agent());
--> statement-breakpoint

-- app_user: no policy is added. The agent gets the directory through a view
-- below, which cannot expose password_hash even by accident.

CREATE OR REPLACE VIEW app.team_directory
WITH (security_barrier = true) AS
  SELECT id, full_name, job_title, role, is_active
    FROM app_user;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Write policies — narrow, and only two of them
-- -----------------------------------------------------------------------------

/* A draft, and only ever a draft. The WITH CHECK is what stops the agent
   inserting a row that is already 'emis' with a number filled in by hand —
   which would bypass app.issue_document() and the gapless counter entirely. */
CREATE POLICY "document_agent_draft_insert" ON "document" FOR INSERT
  WITH CHECK (
    app.is_agent()
    AND "status" = 'brouillon'
    AND "number" IS NULL
    AND "number_year" IS NULL
    AND "number_seq" IS NULL
    AND "created_by_id" = app.agent_user_id()
  );
--> statement-breakpoint

CREATE POLICY "document_line_agent_insert" ON "document_line" FOR INSERT
  WITH CHECK (
    app.is_agent()
    AND EXISTS (
      SELECT 1 FROM document d
       WHERE d.id = "document_id"
         AND d.status = 'brouillon'
         AND d.created_by_id = app.agent_user_id()
    )
  );
--> statement-breakpoint

/* A hand-entered ledger line under its own name. `is_automatic = false` keeps
   it out of the space reserved for the invoice and recurring triggers. */
CREATE POLICY "finance_agent_insert" ON "finance_entry" FOR INSERT
  WITH CHECK (
    app.is_agent()
    AND "is_automatic" = false
    AND "recorded_by_id" = app.agent_user_id()
    AND "document_id" IS NULL
    AND "recurring_entry_id" IS NULL
  );
--> statement-breakpoint

-- No UPDATE policy and no DELETE policy is created for the agent on any table.
-- Under RLS, absent means denied: an UPDATE it attempts matches zero rows, and
-- a DELETE removes nothing. There is nothing to switch off later by mistake.

-- -----------------------------------------------------------------------------
-- 4. Close the number-assignment door explicitly
--
-- app.issue_document is SECURITY DEFINER, so a grant would let the agent run it
-- with the owner's rights and mint a number. It already refuses a non-admin
-- caller, but belt and braces: the EXECUTE grant is never given, and the
-- function refuses an agent session by name.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.issue_document(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  d document%ROWTYPE; c company%ROWTYPE;
  v_lines integer; v_subtotal bigint; v_discount bigint; v_excl bigint;
  v_vat bigint; v_incl bigint; v_withheld bigint;
  v_number text; v_seq integer; v_year integer;
BEGIN
  -- An agent may never assign a number, whatever else it is allowed to do.
  IF app.is_agent() THEN
    RAISE EXCEPTION 'The agent cannot issue a document. A draft has to be issued by a person.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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
$$;

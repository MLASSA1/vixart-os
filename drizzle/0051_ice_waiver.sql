-- =============================================================================
-- 0051 — Issuing an invoice without the client's ICE, on the record.
--
-- The requirement stays. What changes is that there is now a way through it
-- that leaves a name and a reason attached, instead of the only available
-- workaround being to type a fake ICE into the client record — which puts an
-- invented registration number on every future document for that client and
-- looks, forever after, exactly like a real one.
--
-- The waiver is deliberately worse to use than doing it properly:
--
--   only an administrator may use it — NOT a moderator, and not the bootstrap
--     door either, so a seed or a migration cannot quietly waive anything;
--   it demands a written reason, not a checkbox;
--   the reason is stored on the document and appended to the activity log,
--     which is append-only;
--   and the document still prints "ICE — non renseigné —", so the invoice is
--     visibly non-conforming to anyone who reads it rather than quietly wrong.
--
-- A waiver is refused when the client HAS an ICE. Recording an excuse for a
-- problem that does not exist would make the log harder to trust, not easier.
-- =============================================================================

ALTER TABLE document ADD COLUMN ice_waiver_reason text;
--> statement-breakpoint

COMMENT ON COLUMN document.ice_waiver_reason IS
  'Why this invoice was issued without the client ICE (CGI art. 145). Admin only, set at issue, never afterwards.';
--> statement-breakpoint

-- Ten characters is not a hurdle for a real reason and does stop "x" and "n/a"
-- standing in for one. The point of the field is that somebody had to explain.
ALTER TABLE document
  ADD CONSTRAINT document_ice_waiver_reason_meaningful
  CHECK (ice_waiver_reason IS NULL OR length(btrim(ice_waiver_reason)) >= 10);
--> statement-breakpoint

-- The activity log has never carried documents. It does now, because this is
-- the one thing about a document worth finding later.
ALTER TABLE activity DROP CONSTRAINT activity_entity_type_valid;
--> statement-breakpoint

ALTER TABLE activity
  ADD CONSTRAINT activity_entity_type_valid
  CHECK (entity_type IN ('company', 'deal', 'project', 'task', 'service', 'user', 'document'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.issue_document(
  p_id uuid,
  p_payment_method text DEFAULT NULL,
  p_ice_waiver_reason text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  d document%ROWTYPE; c company%ROWTYPE;
  v_lines integer; v_subtotal bigint; v_discount bigint; v_excl bigint;
  v_vat bigint; v_incl bigint; v_withheld bigint;
  v_number text; v_seq integer; v_year integer;
  v_method text; v_waiver text; v_needs_ice boolean;
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

  SELECT * INTO c FROM company WHERE id = d.company_id;

  v_method := coalesce(nullif(btrim(coalesce(p_payment_method, '')), ''), d.payment_method);
  v_waiver := nullif(btrim(coalesce(p_ice_waiver_reason, '')), '');

  -- --- article 145, for invoices only -------------------------------------
  IF d.doc_type IN ('facture', 'avoir') THEN
    -- A particulier has no ICE to give and is never asked for one.
    v_needs_ice := NOT c.is_individual AND coalesce(btrim(c.ice), '') = '';

    IF v_needs_ice THEN
      IF v_waiver IS NULL THEN
        RAISE EXCEPTION
          'This client has no ICE. Article 145 of the CGI requires the ICE of both parties on an invoice — add it to %, mark them a private individual, or issue it with a written reason.', c.name
          USING ERRCODE = 'restrict_violation';
      END IF;

      -- Deliberately app.is_admin() alone: not a moderator, and not the
      -- bootstrap door, so nothing automated can waive this.
      IF NOT app.is_admin() THEN
        RAISE EXCEPTION
          'Only an administrator can issue an invoice without the client ICE.'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF v_waiver IS NOT NULL THEN
      RAISE EXCEPTION
        'No waiver is needed: % has an ICE, or is a private individual.', c.name
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_method IS NULL THEN
      RAISE EXCEPTION
        'Choose a mode de règlement. Article 145 of the CGI requires it on an invoice.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF v_waiver IS NOT NULL THEN
    RAISE EXCEPTION 'A quote has no ICE requirement to waive.'
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
    client_address = concat_ws(', ', c.address_line, c.city),
    client_is_individual = c.is_individual,
    payment_method = v_method,
    ice_waiver_reason = v_waiver
  WHERE id = p_id;

  -- Append-only, and the reason goes in it verbatim. The number is the label
  -- because that is what somebody will be looking for years from now.
  IF v_waiver IS NOT NULL THEN
    INSERT INTO activity (actor_id, actor_name, entity_type, entity_id, entity_label, action, detail)
    VALUES (app.current_user_id(), app.actor_name(), 'document', p_id, v_number,
            'issued without the client ICE', v_waiver);
  END IF;

  RETURN v_number;
END;
$$;

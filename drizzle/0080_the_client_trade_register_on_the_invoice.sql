/*
 * The client's trade register on the document, because Amin asked for it.
 *
 * "can add client detail comapny name ice rc and adress" — the name, the ICE,
 * the IF and the address were already captured at issue and printed; the RC was
 * not. `company.registre_commerce` has existed since 0000 and the company form
 * has always collected it, so the number was in the system and simply never
 * reached an invoice.
 *
 * SNAPSHOTTED, NOT JOINED. Every other client detail on a document is copied at
 * the moment of issue and frozen, because an invoice states what was true on
 * its date — if the client re-registers next year, last year's invoice must not
 * silently change. So `client_rc` joins the snapshot in `app.issue_document`
 * and the frozen list in `app.enforce_document_immutability`, and a document
 * already issued keeps a NULL: there is nothing to backfill it from that would
 * be honest, since the company record may have changed since.
 *
 * Both functions are re-stated in full below rather than patched, which is the
 * only way CREATE OR REPLACE works, and the text is taken verbatim from 0051
 * and 0036 with one line added to each.
 */

ALTER TABLE document ADD COLUMN IF NOT EXISTS client_rc text;
--> statement-breakpoint

COMMENT ON COLUMN document.client_rc IS
  'The client trade register number as it stood when the document was issued '
  '(0080). NULL on anything issued before that, on purpose: the company record '
  'may have changed since, so there is nothing honest to backfill from.';
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
    client_rc = c.registre_commerce,
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_document_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'brouillon' THEN
    RETURN NEW;   -- a draft is freely editable
  END IF;

  IF OLD.status = 'brouillon' AND NEW.status = 'emis' THEN
    RETURN NEW;
  END IF;

  IF NEW.doc_type          IS DISTINCT FROM OLD.doc_type
  OR NEW.company_id        IS DISTINCT FROM OLD.company_id
  OR NEW.number            IS DISTINCT FROM OLD.number
  OR NEW.number_year       IS DISTINCT FROM OLD.number_year
  OR NEW.number_seq        IS DISTINCT FROM OLD.number_seq
  OR NEW.issue_date        IS DISTINCT FROM OLD.issue_date
  OR NEW.vat_rate_bp       IS DISTINCT FROM OLD.vat_rate_bp
  OR NEW.withholding       IS DISTINCT FROM OLD.withholding
  OR NEW.withholding_rate_bp IS DISTINCT FROM OLD.withholding_rate_bp
  OR NEW.discount_centimes IS DISTINCT FROM OLD.discount_centimes
  OR NEW.advance_expected_centimes IS DISTINCT FROM OLD.advance_expected_centimes
  OR NEW.total_excl_vat    IS DISTINCT FROM OLD.total_excl_vat
  OR NEW.total_vat         IS DISTINCT FROM OLD.total_vat
  OR NEW.total_incl_vat    IS DISTINCT FROM OLD.total_incl_vat
  OR NEW.withheld          IS DISTINCT FROM OLD.withheld
  OR NEW.net_to_collect    IS DISTINCT FROM OLD.net_to_collect
  OR NEW.client_name       IS DISTINCT FROM OLD.client_name
  OR NEW.client_ice        IS DISTINCT FROM OLD.client_ice
  OR NEW.client_if         IS DISTINCT FROM OLD.client_if
  OR NEW.client_rc         IS DISTINCT FROM OLD.client_rc
  OR NEW.client_address    IS DISTINCT FROM OLD.client_address THEN
    RAISE EXCEPTION
      'Document % was issued and cannot be modified. Issue a credit note (avoir) to correct it.',
      OLD.number
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'emis' AND NEW.status IN ('paye','annule')) THEN
    RAISE EXCEPTION 'Cannot move document % from % to %.', OLD.number, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 0049 — What article 145 of the CGI actually requires on an invoice.
--
-- Two things were missing, and both are conditions of the document being valid
-- rather than presentation:
--
--   the client's ICE. Ours has always printed; theirs is frozen onto the
--   document at issue and then omitted from the page whenever it is empty,
--   which is exactly the case where somebody needs to see that it is missing.
--
--   the mode de règlement. Not recorded anywhere at all.
--
-- Both are enforced where issuing happens, not in a form. A form can be
-- bypassed by any other caller; `app.issue_document` is the single door every
-- document goes through to get a number, and a document that cannot be issued
-- cannot be sent.
--
-- The rule applies to `facture` and `avoir` — a credit note is an invoice for
-- fiscal purposes and carries the same obligations. NOT to `devis`: a quote is
-- an offer, has no fiscal existence, and is frequently the thing you send
-- BEFORE the client has given you their ICE.
-- =============================================================================

ALTER TABLE document ADD COLUMN payment_method text;
--> statement-breakpoint

COMMENT ON COLUMN document.payment_method IS
  'Mode de règlement (CGI art. 145). Chosen when the document is issued; null on a quote.';
--> statement-breakpoint

ALTER TABLE document
  ADD CONSTRAINT document_payment_method_valid
  CHECK (payment_method IS NULL OR payment_method IN ('virement', 'cheque', 'especes'));
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Issuing, with the two new conditions.
--
-- Dropped and recreated rather than replaced: the signature gains a parameter,
-- and leaving the one-argument version in place would make every existing
-- single-argument call ambiguous. With a default, those calls now resolve here
-- and behave as they did — except that an invoice missing either field is
-- refused instead of issued.
-- -----------------------------------------------------------------------------

DROP FUNCTION app.issue_document(uuid);
--> statement-breakpoint

CREATE FUNCTION app.issue_document(p_id uuid, p_payment_method text DEFAULT NULL)
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
  v_method text;
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

  -- The passed value wins; otherwise whatever is already on the row.
  v_method := coalesce(nullif(btrim(coalesce(p_payment_method, '')), ''), d.payment_method);

  -- --- article 145, for invoices only -------------------------------------
  IF d.doc_type IN ('facture', 'avoir') THEN
    IF coalesce(btrim(c.ice), '') = '' THEN
      RAISE EXCEPTION
        'This client has no ICE. Article 145 of the CGI requires the ICE of both parties on an invoice — add it to % before issuing.', c.name
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_method IS NULL THEN
      RAISE EXCEPTION
        'Choose a mode de règlement. Article 145 of the CGI requires it on an invoice.'
        USING ERRCODE = 'restrict_violation';
    END IF;
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
    payment_method = v_method
  WHERE id = p_id;

  RETURN v_number;
END;
$$;

-- =============================================================================
-- 0050 — A client who is a person, not a company.
--
-- Article 145 wants the ICE of both parties on an invoice, and a private
-- individual has none: the ICE is a company registration. Requiring one from
-- everybody leaves exactly one way to invoice a person — type a fake ICE to
-- get past the check — which puts an invented registration number on a fiscal
-- document. The check has to know the difference instead.
--
-- A boolean rather than a `client_kind` enum: there are two cases, the default
-- is the overwhelmingly common one, and every row that exists today is a
-- company.
-- =============================================================================

ALTER TABLE company
  ADD COLUMN is_individual boolean NOT NULL DEFAULT false;
--> statement-breakpoint

COMMENT ON COLUMN company.is_individual IS
  'A private individual (particulier) rather than a business. Has no ICE, so article 145 does not ask for one.';
--> statement-breakpoint

-- Frozen onto the document at issue, beside the rest of the client identity.
-- A document must still render correctly years later if the client record is
-- edited — the same reason client_name and client_ice are copied there.
ALTER TABLE document
  ADD COLUMN client_is_individual boolean NOT NULL DEFAULT false;
--> statement-breakpoint

COMMENT ON COLUMN document.client_is_individual IS
  'What the client was at issue. Frozen, like client_name and client_ice.';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.issue_document(p_id uuid, p_payment_method text DEFAULT NULL)
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

  v_method := coalesce(nullif(btrim(coalesce(p_payment_method, '')), ''), d.payment_method);

  -- --- article 145, for invoices only -------------------------------------
  IF d.doc_type IN ('facture', 'avoir') THEN
    -- A particulier has no ICE to give. The mode de règlement is still
    -- required: that obligation is about the invoice, not about who is paying.
    IF NOT c.is_individual AND coalesce(btrim(c.ice), '') = '' THEN
      RAISE EXCEPTION
        'This client has no ICE. Article 145 of the CGI requires the ICE of both parties on an invoice — add it to %, or mark them a private individual.', c.name
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
    client_is_individual = c.is_individual,
    payment_method = v_method
  WHERE id = p_id;

  RETURN v_number;
END;
$$;

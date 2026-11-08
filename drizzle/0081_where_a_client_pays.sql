/*
 * Where a client pays, in the database and editable by Amin.
 *
 * It was a constant in `src/lib/vixart.ts`, deliberately left empty: a
 * plausible-looking RIB on an issued invoice sends a client's money to a number
 * nobody checked, so the PDF printed "— non renseigné —" rather than a guess.
 * That is also why every invoice so far has looked unfinished.
 *
 * Amin asked for it in the database rather than the code, so the account can
 * change without waiting on a deploy. One row, admin-only, with a form on
 * /system.
 *
 * SNAPSHOTTED ONTO EACH DOCUMENT AT ISSUE, which is the part that matters.
 * A client who paid last year paid into the account printed on last year's
 * invoice. If the PDF read the current row, changing banks would silently
 * rewrite the payment instructions on every invoice ever issued — including the
 * ones in a client's accounts, and the ones in ours. So the four values join
 * the frozen snapshot beside client_name, client_ice and client_rc, and the
 * renderer reads the snapshot for an issued document and the live row only for
 * a draft preview, which has no number and claims nothing.
 *
 * SHAPES, CHECKED. A Moroccan RIB is 24 digits, a Moroccan IBAN is 28
 * characters beginning MA, and a BIC is 8 or 11. These are standards rather
 * than my invention, and the form strips spaces before saving so that pasting
 * "007 780 0001234567890123 45" works. The point is not tidiness: a transposed
 * digit in a RIB is money in somebody else's account, and the shape is the only
 * part of that a database can catch.
 *
 * Still no values here. Nothing in this migration guesses one.
 */

CREATE TABLE payment_detail (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  bank_name   text CONSTRAINT payment_detail_bank_name_present
              CHECK (bank_name IS NULL OR length(trim(bank_name)) > 0),

  -- 24 digits. Stored without the spaces a bank statement prints.
  rib         text CONSTRAINT payment_detail_rib_shape
              CHECK (rib IS NULL OR rib ~ '^[0-9]{24}$'),

  -- Two letters then the rest; 15–34 overall is the ISO range, and Morocco's
  -- own is 28. Not narrowed to MA: a foreign account is a thing a client could
  -- one day be asked to pay into, and refusing it here would be a guess.
  iban        text CONSTRAINT payment_detail_iban_shape
              CHECK (iban IS NULL OR iban ~ '^[A-Z]{2}[0-9A-Z]{13,32}$'),

  -- BIC: 8 or 11, no other length exists.
  swift       text CONSTRAINT payment_detail_swift_shape
              CHECK (swift IS NULL OR swift ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'),

  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by_id uuid REFERENCES app_user(id) ON DELETE SET NULL
);
--> statement-breakpoint

/*
 * One row, for ever. The expression index is how PostgreSQL spells "singleton":
 * every row indexes the same key, so the second insert collides. Without it
 * somebody saves twice, two rows exist, and `LIMIT 1` starts choosing which
 * bank account to print.
 */
CREATE UNIQUE INDEX payment_detail_one_row ON payment_detail ((true));
--> statement-breakpoint

ALTER TABLE payment_detail ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payment_detail FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY payment_detail_bootstrap ON payment_detail
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

/*
 * Administrators only, read included.
 *
 * A moderator runs the board and a member does the work; neither needs the
 * company's bank account, and the fewer sessions that can read it the smaller
 * the blast radius if one is stolen. `app.issue_document` is SECURITY DEFINER,
 * so snapshotting still works for whoever issues the invoice.
 */
CREATE POLICY payment_detail_admin ON payment_detail
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON payment_detail TO vixart_app;
--> statement-breakpoint

COMMENT ON TABLE payment_detail IS
  'The one bank account a client pays into. One row, admin-only, edited on '
  '/system. Copied onto each document at issue (0081) so an issued invoice '
  'keeps the account it was issued with.';
--> statement-breakpoint

-- The row exists from the start, empty, so the form always edits rather than
-- having to decide between inserting and updating.
INSERT INTO payment_detail (bank_name) VALUES (NULL) ON CONFLICT DO NOTHING;
--> statement-breakpoint

ALTER TABLE document
  ADD COLUMN IF NOT EXISTS issuer_bank_name  text,
  ADD COLUMN IF NOT EXISTS issuer_bank_rib   text,
  ADD COLUMN IF NOT EXISTS issuer_bank_iban  text,
  ADD COLUMN IF NOT EXISTS issuer_bank_swift text;
--> statement-breakpoint

COMMENT ON COLUMN document.issuer_bank_rib IS
  'The account this document asked to be paid into, as it stood at issue '
  '(0081). NULL on anything issued before that, and on a document issued while '
  'the details were still blank.';
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
    issuer_bank_name  = (SELECT bank_name FROM payment_detail LIMIT 1),
    issuer_bank_rib   = (SELECT rib       FROM payment_detail LIMIT 1),
    issuer_bank_iban  = (SELECT iban      FROM payment_detail LIMIT 1),
    issuer_bank_swift = (SELECT swift     FROM payment_detail LIMIT 1),
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
  OR NEW.issuer_bank_name  IS DISTINCT FROM OLD.issuer_bank_name
  OR NEW.issuer_bank_rib   IS DISTINCT FROM OLD.issuer_bank_rib
  OR NEW.issuer_bank_iban  IS DISTINCT FROM OLD.issuer_bank_iban
  OR NEW.issuer_bank_swift IS DISTINCT FROM OLD.issuer_bank_swift
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

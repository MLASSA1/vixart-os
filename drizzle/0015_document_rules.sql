-- =============================================================================
-- 0015 — Numbering, issue, and immutability.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Gapless sequential numbering
--
-- A real sequence is deliberately NOT used: sequences are non-transactional and
-- leave gaps on rollback, and a gap in an invoice run is a problem with the tax
-- authority, not a cosmetic issue.
--
-- Instead: one counter row per (type, year), taken with SELECT ... FOR UPDATE.
-- Concurrent issuers queue on that lock, so they cannot receive the same
-- number. If a transaction rolls back, its increment rolls back with it and the
-- number is handed to the next caller — the run stays unbroken.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.next_document_number(p_type text, p_year integer)
RETURNS TABLE (number text, seq integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq    integer;
  v_prefix text;
BEGIN
  v_prefix := CASE p_type
                WHEN 'devis'   THEN 'DEV'
                WHEN 'facture' THEN 'FAC'
                WHEN 'avoir'   THEN 'AV'
              END;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'Unknown document type: %', p_type USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Create the counter for this type-year if this is the first document of it.
  INSERT INTO document_counter (doc_type, year, last_seq)
  VALUES (p_type, p_year, 0)
  ON CONFLICT (doc_type, year) DO NOTHING;

  -- The lock. Everything after this is serialised per (type, year).
  SELECT c.last_seq INTO v_seq
    FROM document_counter c
   WHERE c.doc_type = p_type AND c.year = p_year
   FOR UPDATE;

  v_seq := v_seq + 1;

  UPDATE document_counter c SET last_seq = v_seq
   WHERE c.doc_type = p_type AND c.year = p_year;

  RETURN QUERY SELECT format('%s-%s-%s', v_prefix, p_year, lpad(v_seq::text, 4, '0')), v_seq;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.next_document_number(text, integer) FROM PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Issuing
--
-- One function, one transaction: compute the totals, freeze the client's
-- identity, take the number, flip the status. Nothing partial can be observed —
-- there is no state where a document has a number but no totals.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.issue_document(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  d              document%ROWTYPE;
  c              company%ROWTYPE;
  v_lines        integer;
  v_subtotal     bigint;
  v_discount     bigint;
  v_excl         bigint;
  v_vat          bigint;
  v_incl         bigint;
  v_withheld     bigint;
  v_number       text;
  v_seq          integer;
  v_year         integer;
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

  -- Totals, in integer centimes throughout. Rounding is half away from zero,
  -- matching src/lib/money.ts so the screen and the document always agree.
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
    status          = 'emis',
    number          = v_number,
    number_year     = v_year,
    number_seq      = v_seq,
    issue_date      = coalesce(issue_date, current_date),
    total_excl_vat  = v_excl,
    total_vat       = v_vat,
    total_incl_vat  = v_incl,
    withheld        = v_withheld,
    net_to_collect  = v_incl - v_withheld,
    -- The client as they are right now, frozen onto the document.
    client_name       = c.name,
    client_legal_name = c.legal_name,
    client_ice        = c.ice,
    client_if         = c.identifiant_fiscal,
    client_address    = concat_ws(', ', c.address_line, c.city)
  WHERE id = p_id;

  RETURN v_number;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.issue_document(uuid) FROM PUBLIC;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Immutability
--
-- Once issued, the financial content of a document can never change. Only the
-- payment status may move (emis -> paye / annule). A wrong invoice is corrected
-- by a credit note, never by an edit.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.enforce_document_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'brouillon' THEN
    RETURN NEW;   -- a draft is freely editable
  END IF;

  -- The issue itself: brouillon -> emis, performed by app.issue_document.
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
  OR NEW.total_excl_vat    IS DISTINCT FROM OLD.total_excl_vat
  OR NEW.total_vat         IS DISTINCT FROM OLD.total_vat
  OR NEW.total_incl_vat    IS DISTINCT FROM OLD.total_incl_vat
  OR NEW.withheld          IS DISTINCT FROM OLD.withheld
  OR NEW.net_to_collect    IS DISTINCT FROM OLD.net_to_collect
  OR NEW.client_name       IS DISTINCT FROM OLD.client_name
  OR NEW.client_ice        IS DISTINCT FROM OLD.client_ice
  OR NEW.client_if         IS DISTINCT FROM OLD.client_if
  OR NEW.client_address    IS DISTINCT FROM OLD.client_address THEN
    RAISE EXCEPTION
      'Document % was issued and cannot be modified. Issue a credit note (avoir) to correct it.',
      OLD.number
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Status may only move forward, and only in legal directions.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'emis' AND NEW.status IN ('paye','annule')) THEN
    RAISE EXCEPTION 'Cannot move document % from % to %.', OLD.number, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "document_immutable" BEFORE UPDATE ON "document"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_document_immutability();
--> statement-breakpoint

-- Lines follow the document: once it is issued, they are frozen too.
CREATE OR REPLACE FUNCTION app.enforce_document_line_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_number text;
  v_doc    uuid;
BEGIN
  v_doc := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  SELECT status, number INTO v_status, v_number FROM document WHERE id = v_doc;

  IF v_status IS DISTINCT FROM 'brouillon' THEN
    RAISE EXCEPTION
      'Document % was issued; its lines cannot be changed. Issue a credit note instead.',
      coalesce(v_number, '(unnumbered)')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "document_line_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "document_line"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_document_line_immutability();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Row level security — documents are money, so management only
-- -----------------------------------------------------------------------------

ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "document_admin" ON "document" FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint
CREATE POLICY "document_bootstrap" ON "document" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

ALTER TABLE "document_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "document_line_admin" ON "document_line" FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());
--> statement-breakpoint
CREATE POLICY "document_line_bootstrap" ON "document_line" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

ALTER TABLE "document_counter" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_counter" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Nothing touches the counter directly; only the SECURITY DEFINER functions do.
CREATE POLICY "document_counter_bootstrap" ON "document_counter" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

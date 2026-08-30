-- VIXART OS — the advance is agreed on the deal, not invented on the invoice.
--
-- How the agency actually gets paid: the client pays a share up front to start
-- the work — a half, a third, a fifth, whatever was negotiated — and the rest
-- when the project is delivered. That agreement is reached while the DEAL is
-- being closed, so it belongs on the deal, and the invoice inherits it.
--
-- Stored in dirhams, not as a percentage. A percentage is how the conversation
-- goes ("thirty percent"); an amount is what the client transfers, what the
-- invoice states, and what the books record. Keeping the amount means a deal
-- whose value is later corrected does not silently change what was agreed —
-- the screen offers 20/30/50% buttons that compute the figure, and the figure
-- is what is kept.

ALTER TABLE deal
  ADD COLUMN advance_centimes bigint NOT NULL DEFAULT 0
  CONSTRAINT deal_advance_not_negative CHECK (advance_centimes >= 0);

COMMENT ON COLUMN deal.advance_centimes IS
  'Agreed up-front payment in centimes. 0 means none was agreed. Carried onto '
  'an invoice built from this deal as the expected first payment.';

-- The same figure on the document, frozen there like every other number on an
-- issued invoice: what was expected up front, recorded beside what arrived.
ALTER TABLE document
  ADD COLUMN advance_expected_centimes bigint NOT NULL DEFAULT 0
  CONSTRAINT document_advance_not_negative CHECK (advance_expected_centimes >= 0);

COMMENT ON COLUMN document.advance_expected_centimes IS
  'The advance agreed on the deal, copied at creation. Compared against the '
  'payments actually recorded — it never itself moves money.';

-- It is a term of the agreement, so it freezes with the rest of the invoice.
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

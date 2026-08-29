-- VIXART OS — advance payments on invoices.
--
-- The agency takes an advance on every engagement, and the advance is an
-- AMOUNT, not a fixed half: 10%, 30%, whatever was agreed, in dirhams. Until
-- now the system only knew "unpaid" and "paid", so an advance was invisible —
-- real money in the till that the books could not see, sometimes for weeks.
--
-- A payment is a fact: on this date, this much arrived, by this method. The
-- table is append-only. When recorded payments cover the invoice's net, the
-- invoice settles itself — nobody "marks" it paid, the money does.
--
-- Each payment posts its OWN ledger line, with its real method and its real
-- date. The old posting (one 'virement' line for the whole invoice, dated the
-- day someone clicked) survives only for invoices settled by hand with no
-- payments recorded.

CREATE TABLE document_payment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES document(id) ON DELETE RESTRICT,
  amount_centimes bigint NOT NULL CONSTRAINT payment_amount_positive CHECK (amount_centimes > 0),
  method          text NOT NULL DEFAULT 'virement'
                  CONSTRAINT payment_method_valid
                  CHECK (method IN ('especes','virement','cheque','carte','autre')),
  paid_on         date NOT NULL DEFAULT current_date,
  note            text,
  created_by_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_by_document ON document_payment (document_id, paid_on);

ALTER TABLE document_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_payment FORCE ROW LEVEL SECURITY;

-- Money screens are management's; the payment table follows the document table.
CREATE POLICY payment_admin ON document_payment
  USING (app.is_admin()) WITH CHECK (app.is_admin());
CREATE POLICY payment_bootstrap ON document_payment
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- ---------------------------------------------------------------------------
-- The ledger line a payment posts is tied to the payment that caused it.
-- Idempotence lives on this column now, per payment — which is why the old
-- one-line-per-document unique index has to go: an invoice paid in three
-- instalments has three income lines, and that is the point.
-- ---------------------------------------------------------------------------
ALTER TABLE finance_entry
  ADD COLUMN document_payment_id uuid
  REFERENCES document_payment(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX finance_one_line_per_payment
  ON finance_entry (document_payment_id) WHERE document_payment_id IS NOT NULL;

DROP INDEX finance_one_line_per_document;

-- Whole-invoice lines (the manual path) stay unique per document; instalment
-- lines are exempted by the second condition.
CREATE UNIQUE INDEX finance_one_manual_line_per_document
  ON finance_entry (document_id)
  WHERE document_id IS NOT NULL AND document_payment_id IS NULL;

-- ---------------------------------------------------------------------------
-- Rules, before a payment lands.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enforce_payment_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d document%ROWTYPE;
  v_paid bigint;
  v_rest bigint;
BEGIN
  -- Serialise per document, or two simultaneous payments could both pass the
  -- over-payment check and together exceed the balance.
  SELECT * INTO d FROM document WHERE id = NEW.document_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found.' USING ERRCODE = 'no_data_found';
  END IF;

  IF d.doc_type <> 'facture' THEN
    RAISE EXCEPTION
      'A payment is recorded against an invoice. For an advance on an accepted quote, issue the invoice first, then record the advance on it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF d.status = 'brouillon' THEN
    RAISE EXCEPTION 'This invoice is still a draft — issue it before recording money against it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF d.status = 'annule' THEN
    RAISE EXCEPTION 'This invoice was cancelled.' USING ERRCODE = 'restrict_violation';
  END IF;

  IF d.status = 'paye' THEN
    RAISE EXCEPTION 'Invoice % is already settled in full.', d.number
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum(amount_centimes), 0) INTO v_paid
    FROM document_payment WHERE document_id = NEW.document_id;
  v_rest := d.net_to_collect - v_paid;

  IF NEW.amount_centimes > v_rest THEN
    RAISE EXCEPTION
      'That is more than remains on %: % DH left to collect.',
      d.number,
      concat((v_rest / 100)::text, ',', lpad((v_rest % 100)::text, 2, '0'))
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_rules
  BEFORE INSERT ON document_payment
  FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_rules();

-- A recorded payment is a fact; facts are not edited. A mistake while the
-- invoice is still open is corrected by delete and re-entry.
CREATE FUNCTION app.forbid_payment_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A payment is never edited. Delete it and record the correct one.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER payment_immutable
  BEFORE UPDATE ON document_payment
  FOR EACH ROW EXECUTE FUNCTION app.forbid_payment_rewrite();

-- Once the invoice is settled, its payments are part of an accounting fact.
-- The document trigger only moves status forward, so un-settling is not even
-- expressible — corrections from here go through a credit note, like every
-- other change to an issued invoice.
CREATE FUNCTION app.enforce_payment_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM document WHERE id = OLD.document_id FOR UPDATE;
  IF v_status = 'paye' THEN
    RAISE EXCEPTION
      'This invoice is settled; its payments are locked. Correct it with a credit note.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER payment_delete_rules
  BEFORE DELETE ON document_payment
  FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_delete();

-- ---------------------------------------------------------------------------
-- After a payment lands: post its ledger line, and settle the invoice when
-- the money covers it.
--
-- VAT per instalment is allocated by cumulative rounding: each line carries
-- round(paid_so_far × vat / net) minus what earlier lines already carried.
-- The last payment therefore absorbs every rounding remainder, and the lines
-- always sum to exactly the invoice's VAT — an accountant can add them up.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.post_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d document%ROWTYPE;
  v_client text;
  v_paid_before bigint;
  v_paid_after bigint;
  v_vat_eff bigint;
  v_vat_before bigint;
  v_vat_after bigint;
BEGIN
  SELECT * INTO d FROM document WHERE id = NEW.document_id;
  SELECT name INTO v_client FROM company WHERE id = d.company_id;

  SELECT coalesce(sum(amount_centimes), 0) INTO v_paid_after
    FROM document_payment WHERE document_id = NEW.document_id;
  v_paid_before := v_paid_after - NEW.amount_centimes;

  v_vat_eff := greatest(d.total_vat - d.withheld, 0);
  IF d.net_to_collect > 0 THEN
    v_vat_before := (v_paid_before * v_vat_eff + d.net_to_collect / 2) / d.net_to_collect;
    v_vat_after  := (v_paid_after  * v_vat_eff + d.net_to_collect / 2) / d.net_to_collect;
  ELSE
    v_vat_before := 0; v_vat_after := 0;
  END IF;

  INSERT INTO finance_entry (
    direction, amount_centimes, vat_centimes, entry_date, category,
    payment_method, description, company_id, document_id, document_payment_id,
    reference, is_automatic, recorded_by_id
  ) VALUES (
    'income',
    NEW.amount_centimes,
    v_vat_after - v_vat_before,
    NEW.paid_on,
    'facture',
    NEW.method,
    concat(
      CASE WHEN v_paid_before = 0 AND v_paid_after < d.net_to_collect
           THEN 'Advance on invoice '
           WHEN v_paid_after >= d.net_to_collect AND v_paid_before > 0
           THEN 'Balance of invoice '
           ELSE 'Payment on invoice ' END,
      d.number, ' — ', coalesce(v_client, 'client')
    ),
    d.company_id,
    d.id,
    NEW.id,
    d.number,
    true,
    app.current_user_id()
  )
  ON CONFLICT (document_payment_id) WHERE document_payment_id IS NOT NULL DO NOTHING;

  -- The money settles the invoice; no button does.
  IF v_paid_after >= d.net_to_collect AND d.status = 'emis' THEN
    UPDATE document
       SET status = 'paye', paid_at = NEW.paid_on::timestamptz
     WHERE id = d.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_posts
  AFTER INSERT ON document_payment
  FOR EACH ROW EXECUTE FUNCTION app.post_payment();

-- Deleting a payment (invoice still open) takes its ledger line with it — the
-- FK cascades — so the books never show money that was taken back out.

-- ---------------------------------------------------------------------------
-- The whole-invoice posting now yields to instalments. It fires only for an
-- invoice marked paid by hand with NO payments recorded — the old behaviour,
-- kept for exactly that case. Its ON CONFLICT target changed with the index.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.post_invoice_revenue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_client text;
BEGIN
  IF NEW.status = 'paye' AND OLD.status IS DISTINCT FROM 'paye'
     AND NEW.doc_type = 'facture'
     AND NOT EXISTS (SELECT 1 FROM document_payment WHERE document_id = NEW.id) THEN

    SELECT name INTO v_client FROM company WHERE id = NEW.company_id;

    INSERT INTO finance_entry (
      direction, amount_centimes, vat_centimes, entry_date, category,
      payment_method, description, company_id, document_id, reference,
      is_automatic, recorded_by_id
    ) VALUES (
      'income',
      NEW.net_to_collect,
      greatest(NEW.total_vat - NEW.withheld, 0),
      coalesce(NEW.paid_at::date, current_date),
      'facture',
      'virement',
      concat('Invoice ', NEW.number, ' — ', coalesce(v_client, 'client')),
      NEW.company_id,
      NEW.id,
      NEW.number,
      true,
      app.current_user_id()
    )
    ON CONFLICT (document_id) WHERE document_id IS NOT NULL AND document_payment_id IS NULL
    DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

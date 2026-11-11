/*
 * A payment is never deleted. A mistake is reversed — by the owner only.
 *
 * Amin, November 2026: when a client pays part of what they owe, the payment
 * is saved, the balance goes down, and "a record of the payment always stays
 * in the data". Asked whether one may ever be removed: "never removed — only
 * my account has that access".
 *
 * WHAT WAS THERE. A payment could not be edited, but it COULD be deleted while
 * its invoice was still open, and the delete cascaded its ledger line away —
 * so a payment could vanish from the books without trace. That is what this
 * closes.
 *
 * HOW IT WORKS NOW — the way accountants have always done it:
 *
 *  - Nothing is ever deleted. `payment_delete_rules` refuses every DELETE.
 *  - A mistaken or bounced payment is cancelled by a REVERSAL: a second row,
 *    `reverses_id` pointing at the first, for exactly minus its amount, with a
 *    written reason. Both rows stay for good; the balance nets back up.
 *  - Only the OWNER may record a reversal. `app_user.is_owner` marks exactly
 *    one person (a unique index), set here for the earliest active
 *    administrator — Amin — and guarded by a trigger so that nobody, admin or
 *    not, can grant it to themselves through the application. Every check is
 *    in the database, so a button hidden in the interface is not the lock.
 *  - A reversal posts a NEGATIVE ledger line next to the original, so the
 *    books show the payment and its correction rather than a silent gap.
 *  - If the reversal leaves a settled invoice short, it reopens: `paye` back
 *    to `emis`, allowed only when a reversal exists and payments no longer
 *    cover the net. Nobody can reopen an invoice any other way.
 *
 * Production held no payments when this was written (only drafts), so nothing
 * existing changes meaning. The purge functions of 0039/0040 disable the
 * delete trigger explicitly and are unaffected.
 */

-- ---------------------------------------------------------------------------
-- The owner.
-- ---------------------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Exactly one, ever: every owner row indexes the same key.
CREATE UNIQUE INDEX IF NOT EXISTS app_user_one_owner ON app_user ((true)) WHERE is_owner;
--> statement-breakpoint

UPDATE app_user SET is_owner = true
 WHERE id = (SELECT id FROM app_user
              WHERE role = 'admin' AND is_active AND NOT is_service_account
              ORDER BY created_at LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM app_user WHERE is_owner);
--> statement-breakpoint

/*
 * Not grantable from the application. `app_user` may be updated by any
 * administrator and by every person on their own row (0021), so without this
 * an administrator — or anybody editing their profile — could make themselves
 * owner and reverse payments. Only a bootstrap session (a migration) may.
 */
CREATE OR REPLACE FUNCTION app.guard_owner_flag() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_owner AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'The owner is not chosen from the application.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.is_owner IS DISTINCT FROM OLD.is_owner AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'The owner is not chosen from the application.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS app_user_guard_owner ON app_user;
--> statement-breakpoint
CREATE TRIGGER app_user_guard_owner
  BEFORE INSERT OR UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION app.guard_owner_flag();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_owner() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT is_owner FROM app_user WHERE id = app.current_user_id()), false);
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reversals.
-- ---------------------------------------------------------------------------
ALTER TABLE document_payment
  ADD COLUMN IF NOT EXISTS reverses_id uuid REFERENCES document_payment(id) ON DELETE RESTRICT;
--> statement-breakpoint

-- One reversal per payment, at most.
CREATE UNIQUE INDEX IF NOT EXISTS payment_reversed_once ON document_payment (reverses_id) WHERE reverses_id IS NOT NULL;
--> statement-breakpoint

-- A payment is positive; a reversal is negative. The name of the first is
-- kept, because the application already words it ("an amount above zero").
ALTER TABLE document_payment DROP CONSTRAINT IF EXISTS payment_amount_positive;
--> statement-breakpoint
ALTER TABLE document_payment ADD CONSTRAINT payment_amount_positive
  CHECK (reverses_id IS NOT NULL OR amount_centimes > 0);
--> statement-breakpoint
ALTER TABLE document_payment ADD CONSTRAINT payment_reversal_negative
  CHECK (reverses_id IS NULL OR amount_centimes < 0);
--> statement-breakpoint

-- The ledger may carry a negative line, but only one tied to a payment — i.e.
-- a reversal — and its VAT carries the same sign. Every other line stays
-- strictly positive, as before.
ALTER TABLE finance_entry DROP CONSTRAINT IF EXISTS finance_amount_positive;
--> statement-breakpoint
ALTER TABLE finance_entry DROP CONSTRAINT IF EXISTS finance_vat_range;
--> statement-breakpoint
ALTER TABLE finance_entry ADD CONSTRAINT finance_amount_positive
  CHECK (amount_centimes > 0 OR (amount_centimes < 0 AND document_payment_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE finance_entry ADD CONSTRAINT finance_vat_range
  CHECK (
    (amount_centimes > 0 AND vat_centimes >= 0 AND vat_centimes <= amount_centimes)
    OR (amount_centimes < 0 AND vat_centimes <= 0 AND vat_centimes >= amount_centimes)
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_payment_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d document%ROWTYPE;
  o document_payment%ROWTYPE;
  v_paid bigint;
  v_rest bigint;
BEGIN
  -- Serialise per document, or two simultaneous payments could both pass the
  -- over-payment check and together exceed the balance.
  SELECT * INTO d FROM document WHERE id = NEW.document_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- ---- a reversal: the owner taking a payment back out ------------------
  IF NEW.reverses_id IS NOT NULL THEN
    IF NOT (app.is_owner() OR app.is_bootstrap()) THEN
      RAISE EXCEPTION 'Only the owner can reverse a payment.' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO o FROM document_payment WHERE id = NEW.reverses_id;
    IF NOT FOUND OR o.document_id <> NEW.document_id THEN
      RAISE EXCEPTION 'That payment is not on this invoice.' USING ERRCODE = 'restrict_violation';
    END IF;
    IF o.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'A reversal cannot itself be reversed.' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.amount_centimes <> -o.amount_centimes THEN
      RAISE EXCEPTION 'A reversal is for exactly the amount of the payment it reverses.' USING ERRCODE = 'restrict_violation';
    END IF;
    IF coalesce(btrim(NEW.note), '') = '' THEN
      RAISE EXCEPTION 'Say why the payment is being reversed.' USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.method := o.method;  -- the money goes back the way it came
    RETURN NEW;
  END IF;

  -- ---- an ordinary payment, exactly as before ----------------------------
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

  -- Reversals are negative, so this is what has really been received.
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.post_payment() RETURNS trigger
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

  -- Cumulative rounding, as before. It holds for a reversal too: the VAT a
  -- reversal takes back is exactly what the running total gives back, so the
  -- lines still add up to the invoice's VAT on whatever remains paid.
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
      CASE WHEN NEW.reverses_id IS NOT NULL
           THEN 'Reversal of a payment on invoice '
           WHEN v_paid_before = 0 AND v_paid_after < d.net_to_collect
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

  -- And a reversal that leaves it short reopens it.
  IF NEW.reverses_id IS NOT NULL AND v_paid_after < d.net_to_collect AND d.status = 'paye' THEN
    UPDATE document SET status = 'emis', paid_at = NULL WHERE id = d.id;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_payment_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A payment is never deleted. The owner can reverse it, and both stay on record.'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.forbid_payment_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A payment is never edited. The owner can reverse it and the correct one can be recorded.'
    USING ERRCODE = 'restrict_violation';
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
     AND NOT (OLD.status = 'emis' AND NEW.status IN ('paye','annule'))
     -- 0083: a settled invoice reopens ONLY because a reversal left it unpaid.
     -- Not a flag anybody can set: the reversal row has to exist, and the
     -- recorded payments have to fall short of the net again.
     AND NOT (
       OLD.status = 'paye' AND NEW.status = 'emis'
       AND EXISTS (SELECT 1 FROM document_payment p WHERE p.document_id = NEW.id AND p.reverses_id IS NOT NULL)
       AND (SELECT coalesce(sum(p.amount_centimes), 0) FROM document_payment p WHERE p.document_id = NEW.id) < NEW.net_to_collect
     ) THEN
    RAISE EXCEPTION 'Cannot move document % from % to %.', OLD.number, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

COMMENT ON COLUMN document_payment.reverses_id IS
  'Set on a reversal: the payment it cancels, for exactly minus its amount. Owner only; nothing is deleted (0083).';
--> statement-breakpoint
COMMENT ON COLUMN app_user.is_owner IS
  'The one person who may reverse a payment. Set by migration, never from the application (0083).';

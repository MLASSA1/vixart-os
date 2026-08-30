-- VIXART OS — fixed charges become a checklist, not an automatic posting.
--
-- Three corrections to how this system talked about money, all from the same
-- misunderstanding: it treated "recurring" as a property of money in general,
-- when it is only ever a property of what the agency PAYS.
--
-- 1. Money in is not recurring. It is what clients actually paid for work
--    sold, and it already arrives through invoices and their payments. The
--    recurring table allowed direction='income', which invited someone to
--    record a salary the agency does not receive. Expenses only from here.
--
-- 2. A fixed charge was posting ITSELF on its due day. That is a claim that
--    money left the account, made by a calendar rather than by a bank. Rent
--    paid late, or not at all that month, still appeared as paid. Now a charge
--    falls DUE and waits to be confirmed — the ledger line is written when
--    Amin says the money went, with the date and the amount it really was.
--
-- 3. Not every charge is fixed. Rent is the same number every month;
--    electricity, fuel and food are not. Both recur, so both belong on the
--    checklist, but a variable one asks for the amount instead of assuming it.
--
-- The checklist needs no new table. finance_entry already carries
-- (recurring_entry_id, period_key) under a unique index, so "is this charge
-- paid for this month" is answered by whether that row exists — and the same
-- index makes paying twice impossible.

-- --------------------------------------------------------------------------
-- 1. Fixed or variable.
-- --------------------------------------------------------------------------
ALTER TABLE recurring_entry
  ADD COLUMN kind text NOT NULL DEFAULT 'fixed'
  CONSTRAINT recurring_kind_valid CHECK (kind IN ('fixed','variable'));

COMMENT ON COLUMN recurring_entry.kind IS
  'fixed: the same amount every month (rent, internet). variable: recurs but '
  'the amount differs each time (electricity, fuel, food) — the checklist asks '
  'for it at payment.';

-- The stored amount is what a fixed charge costs, and for a variable one it is
-- the usual figure, offered as a starting point and expected to be edited.
COMMENT ON COLUMN recurring_entry.amount_centimes IS
  'For a fixed charge, the amount due. For a variable one, a typical amount, '
  'pre-filled at payment and meant to be corrected.';

-- --------------------------------------------------------------------------
-- 2. Expenses only.
-- --------------------------------------------------------------------------
UPDATE recurring_entry SET direction = 'expense' WHERE direction <> 'expense';

ALTER TABLE recurring_entry
  ADD CONSTRAINT recurring_expense_only CHECK (direction = 'expense');

-- --------------------------------------------------------------------------
-- 3. Categories for the spending that actually happens here.
-- --------------------------------------------------------------------------
ALTER TABLE finance_entry DROP CONSTRAINT finance_category_valid;
ALTER TABLE finance_entry ADD CONSTRAINT finance_category_valid CHECK (
  category IN (
    -- money in
    'facture','autre_revenu',
    -- fixed, month after month
    'loyer','internet','telephone','salaires','logiciel','impots','frais_bancaires',
    -- metered: recurs, amount moves
    'electricite','eau',
    -- variable spending
    'carburant','repas','deplacement','equipement','fournitures',
    'sous_traitance','marketing','autre_depense'
  )
);

ALTER TABLE recurring_entry DROP CONSTRAINT IF EXISTS recurring_category_valid;
ALTER TABLE recurring_entry ADD CONSTRAINT recurring_category_valid CHECK (
  category IN (
    'loyer','internet','telephone','salaires','logiciel','impots','frais_bancaires',
    'electricite','eau','carburant','repas','deplacement','equipement','fournitures',
    'sous_traitance','marketing','autre_depense'
  )
);

-- --------------------------------------------------------------------------
-- 4. Paying a charge for one month.
--
-- Replaces app.post_due_recurring(), which posted every due period on a timer.
-- The unique index does the idempotence, so a double click, a double submit
-- and a retry all land the same single row.
-- --------------------------------------------------------------------------
CREATE FUNCTION app.pay_charge(
  p_charge  uuid,
  p_period  text,     -- 'YYYY-MM'
  p_amount  bigint,   -- what actually left the account
  p_paid_on date,
  p_method  text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c  recurring_entry%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can record a charge as paid.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_period !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'A period looks like 2026-08, not %.', p_period
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A payment has to be an amount above zero.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO c FROM recurring_entry WHERE id = p_charge;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That charge no longer exists.' USING ERRCODE = 'no_data_found';
  END IF;

  -- A charge cannot be paid for a month before it started: that would be
  -- inventing history rather than recording it.
  IF to_date(p_period || '-01', 'YYYY-MM-DD') < date_trunc('month', c.start_date) THEN
    RAISE EXCEPTION 'This charge only starts in %.', to_char(c.start_date, 'YYYY-MM')
      USING ERRCODE = 'restrict_violation';
  END IF;

  INSERT INTO finance_entry (
    direction, amount_centimes, vat_centimes, entry_date, category,
    payment_method, description, company_id, recurring_entry_id, period_key,
    is_automatic, recorded_by_id
  ) VALUES (
    'expense', p_amount, 0, coalesce(p_paid_on, current_date), c.category,
    coalesce(nullif(p_method, ''), c.payment_method),
    concat(c.description, ' — ', p_period),
    c.company_id, c.id, p_period,
    false,                       -- a person confirmed this, not a timer
    app.current_user_id()
  )
  ON CONFLICT (recurring_entry_id, period_key)
    WHERE recurring_entry_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;   -- null when it was already paid, which is not an error
END;
$$;

-- Unticking: the charge was not actually paid, or was recorded wrong.
CREATE FUNCTION app.unpay_charge(p_charge uuid, p_period text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can undo a charge payment.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM finance_entry
   WHERE recurring_entry_id = p_charge AND period_key = p_period;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- --------------------------------------------------------------------------
-- 5. The timer stops.
--
-- Dropped rather than left in place: a function that silently writes ledger
-- rows behind a checklist is precisely the confusion this migration removes.
-- scripts/nightly.sh no longer calls it and now only takes the backup.
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app.post_due_recurring(date);

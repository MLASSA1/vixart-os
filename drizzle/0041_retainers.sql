-- VIXART OS — retainers: a committed monthly contract, not a rolling one.
--
-- The agency is moving from one-off projects to a base of monthly clients, and
-- the system could not represent that at all: recurring_entry is expense-only
-- by design, so the only recurring thing it knew about was money going out.
--
-- THE TERM IS THE POINT.
--
-- An open-ended month-to-month retainer lets a client take the first month —
-- the audit, the brand work, the setup, the whole heavy end of the engagement —
-- and leave before any of the compounding work pays for itself. A committed
-- term is what stops that, so it is in the table rather than in a policy
-- somebody remembers: term_months, defaulting to three, which is the shortest
-- term that makes the first month's work worth doing.
--
-- end_date is therefore DERIVED — the natural expiry of a term — not a field
-- left blank until someone thinks to fill it. It can still be set explicitly,
-- and an explicit value wins, because a negotiated early finish is a real
-- thing and the schema should not argue with reality.
--
-- Ending inside a committed term is allowed and must say why. Churn reason is
-- the most useful column this table will ever have.

CREATE TABLE retainer (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES company(id) ON DELETE RESTRICT,
  label             text NOT NULL
                    CONSTRAINT retainer_label_present CHECK (length(trim(label)) > 0),

  -- Money, in centimes, like everything else that touches money here.
  monthly_centimes  bigint NOT NULL
                    CONSTRAINT retainer_monthly_positive CHECK (monthly_centimes > 0),

  -- The VAT rate in force when the contract was agreed, frozen onto it. The
  -- rate can change; what was agreed with this client did not.
  vat_rate_bp       integer NOT NULL
                    CONSTRAINT retainer_vat_sane CHECK (vat_rate_bp BETWEEN 0 AND 10000),

  start_date        date NOT NULL,

  -- The commitment. Three months by default.
  term_months       integer NOT NULL DEFAULT 3
                    CONSTRAINT retainer_term_sane CHECK (term_months BETWEEN 1 AND 36),
  auto_renew        boolean NOT NULL DEFAULT true,

  -- Explicit override. NULL means "derive it from start + term", which is the
  -- normal case; a value here is a negotiated finish and wins.
  end_date          date
                    CONSTRAINT retainer_end_after_start
                    CHECK (end_date IS NULL OR end_date > start_date),

  -- Capped at 28 so February is never a special case, exactly as the recurring
  -- charge table does it.
  billing_day       integer NOT NULL DEFAULT 1
                    CONSTRAINT retainer_billing_day_sane CHECK (billing_day BETWEEN 1 AND 28),

  status            text NOT NULL DEFAULT 'active'
                    CONSTRAINT retainer_status_valid CHECK (status IN ('active','paused','ended')),

  ended_on          date,
  end_reason        text,

  notes             text,
  created_by_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Ending without saying why loses the only field that explains churn.
  CONSTRAINT retainer_ended_needs_reason
    CHECK (status <> 'ended' OR (end_reason IS NOT NULL AND length(trim(end_reason)) > 0))
);

CREATE INDEX retainer_by_company ON retainer (company_id);
CREATE INDEX retainer_active     ON retainer (status, billing_day) WHERE status = 'active';

ALTER TABLE retainer ENABLE ROW LEVEL SECURITY;
ALTER TABLE retainer FORCE ROW LEVEL SECURITY;

-- A retainer is a revenue contract: the same reach as a deal, which is what it
-- grows out of. Not the narrower money-only reach of an invoice.
CREATE POLICY retainer_bootstrap ON retainer
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
CREATE POLICY retainer_select ON retainer FOR SELECT USING (app.is_moderator());
CREATE POLICY retainer_write  ON retainer FOR ALL
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());

CREATE TRIGGER retainer_touch_updated_at BEFORE UPDATE ON retainer
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Term arithmetic, in the database, so every screen and the drafting job agree.
-- ---------------------------------------------------------------------------

-- The end of the term this retainer is in TODAY.
--
-- An explicit end_date wins. Otherwise: the first term ends at start + term,
-- and if it auto-renews it keeps rolling forward a term at a time. If it does
-- not renew, the first term end is the end, full stop.
CREATE FUNCTION app.retainer_term_end(
  p_start date, p_term integer, p_auto boolean, p_end date,
  p_today date DEFAULT current_date
) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_end IS NOT NULL THEN p_end
    WHEN NOT p_auto THEN (p_start + (p_term || ' months')::interval)::date
    ELSE (
      p_start + ((
        floor(
          (extract(year  FROM age(greatest(p_today, p_start), p_start)) * 12
         + extract(month FROM age(greatest(p_today, p_start), p_start)))::numeric / p_term
        ) + 1
      ) * p_term || ' months')::interval
    )::date
  END;
$$;

COMMENT ON FUNCTION app.retainer_term_end(date,integer,boolean,date,date) IS
  'The date the retainer''s CURRENT term expires. An explicit end_date wins; '
  'otherwise start + term, rolled forward while auto_renew is on.';

-- Is the retainer still inside the term the client originally committed to?
-- True means they cannot leave without breaking a commitment. False means the
-- contract is on renewal — which is precisely when a client is at risk.
CREATE FUNCTION app.retainer_in_committed_term(
  p_start date, p_term integer, p_today date DEFAULT current_date
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_today < (p_start + (p_term || ' months')::interval)::date;
$$;

-- ---------------------------------------------------------------------------
-- The monthly draft.
--
-- A DRAFT, never an invoice. Issuing assigns a gapless number and freezes the
-- figures, and that stays a human act — the system prepares the paperwork, a
-- person signs it.
-- ---------------------------------------------------------------------------

ALTER TABLE document
  ADD COLUMN retainer_id uuid REFERENCES retainer(id) ON DELETE SET NULL,
  ADD COLUMN retainer_period text
    CONSTRAINT document_retainer_period_shape
    CHECK (retainer_period IS NULL OR retainer_period ~ '^\d{4}-\d{2}$');

-- The idempotency, same shape as finance_entry's (recurring_entry_id,
-- period_key): a period can only ever be drafted once, however many times the
-- job runs, restarts, or is triggered by hand.
CREATE UNIQUE INDEX document_one_per_retainer_period
  ON document (retainer_id, retainer_period)
  WHERE retainer_id IS NOT NULL;

CREATE FUNCTION app.draft_retainer_invoices(p_today date DEFAULT current_date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r        retainer%ROWTYPE;
  c        company%ROWTYPE;
  v_period text := to_char(p_today, 'YYYY-MM');
  v_doc    uuid;
  v_made   integer := 0;
  v_term_end date;
BEGIN
  IF NOT app.is_moderator() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can draft retainer invoices.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR r IN
    SELECT * FROM retainer
     WHERE status = 'active'
       AND start_date <= p_today
       -- The billing day has arrived this month.
       AND billing_day <= extract(day FROM p_today)
  LOOP
    v_term_end := app.retainer_term_end(
      r.start_date, r.term_months, r.auto_renew, r.end_date, p_today);

    -- A contract that has run out drafts nothing, whatever its status says.
    IF v_term_end <= p_today THEN
      CONTINUE;
    END IF;

    SELECT * INTO c FROM company WHERE id = r.company_id;

    INSERT INTO document (
      doc_type, status, company_id, vat_rate_bp,
      withholding, withholding_rate_bp,
      issue_date, subject,
      client_name, client_legal_name, client_ice, client_if, client_address,
      retainer_id, retainer_period, created_by_id
    ) VALUES (
      'facture', 'brouillon', r.company_id, r.vat_rate_bp,
      coalesce(c.retenue_source, false),
      coalesce((SELECT rate_bp FROM fiscal_rate
                 WHERE key='retenue_source_tva' AND effective_from <= p_today
                 ORDER BY effective_from DESC LIMIT 1), 0),
      -- Dated the billing day of this month, not the day the job happened to
      -- run: a draft created late still belongs to its billing date.
      make_date(extract(year FROM p_today)::int, extract(month FROM p_today)::int, r.billing_day),
      r.label || ' — ' || to_char(p_today, 'FMMonth YYYY'),
      c.name, c.legal_name, c.ice, c.identifiant_fiscal,
      nullif(concat_ws(', ', nullif(c.address_line,''), nullif(c.city,'')), ''),
      r.id, v_period, r.created_by_id
    )
    ON CONFLICT (retainer_id, retainer_period) WHERE retainer_id IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_doc;

    IF v_doc IS NOT NULL THEN
      INSERT INTO document_line
        (document_id, label, unit, unit_price_centimes, quantity_millis, position)
      VALUES (v_doc, r.label, 'mois', r.monthly_centimes, 1000, 0);
      v_made := v_made + 1;
      v_doc := NULL;
    END IF;
  END LOOP;

  RETURN v_made;
END;
$$;

COMMENT ON FUNCTION app.draft_retainer_invoices(date) IS
  'Creates this month''s DRAFT invoice for every active retainer whose billing '
  'day has arrived and whose term has not expired. Idempotent: a period can be '
  'drafted once. Never issues — that stays a human act.';

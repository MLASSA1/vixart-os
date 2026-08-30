-- VIXART OS — close the gap between a guarded page and an unguarded action.
--
-- Found by auditing every SECURITY DEFINER function against its callers.
--
-- A SECURITY DEFINER function owned by the superuser runs OUTSIDE row level
-- security — FORCE included. That is the whole point of the mechanism, and it
-- means the function itself is the only thing standing between a caller and
-- the table. Seven of these functions open with an is_admin() check. Two did
-- not, and one of those was reachable.
--
-- The reachable one is app.post_due_recurring(), called from three server
-- actions on /finance. That page redirects a non-admin away — but a page guard
-- protects RENDERING, not the action endpoint behind it, and a server action is
-- an HTTP endpoint that takes whatever session presents itself. A member could
-- therefore post rent and salary lines into finance_entry, a table whose only
-- policy is is_admin(), and not be able to read back what they had written.
--
-- Nothing forged: the content comes from recurring_entry templates only an
-- admin can create, and the posting is idempotent. But an unauthorised write to
-- management-only data is a broken boundary whatever the payload, and the
-- fix is the guard the sibling functions already carry.

CREATE OR REPLACE FUNCTION app.post_due_recurring(p_today date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r          recurring_entry%ROWTYPE;
  v_cursor   date;
  v_period   text;
  v_due      date;
  v_posted   integer := 0;
  v_step     interval;
BEGIN
  -- Posting recurring costs writes to finance_entry, which is management-only.
  -- This function is SECURITY DEFINER and owned by the superuser, so it runs
  -- OUTSIDE row level security: without this check the policy on finance_entry
  -- never gets a say, and any authenticated session reaching a server action
  -- that calls this could write ledger rows it cannot even read back.
  --
  -- Every other SECURITY DEFINER function here opens with a guard like this.
  -- This one was written without one, and nothing caught it because the page
  -- that offers the button is admin-gated — a page guard protects rendering,
  -- not the action endpoint behind it.
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can post recurring costs.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN
    SELECT * FROM recurring_entry
     WHERE is_active
       AND start_date <= p_today
       AND (end_date IS NULL OR end_date >= start_date)
  LOOP
    v_step := CASE r.frequency
                WHEN 'monthly'   THEN interval '1 month'
                WHEN 'quarterly' THEN interval '3 months'
                ELSE                  interval '1 year'
              END;

    -- Start at the first period boundary on or before start_date.
    v_cursor := date_trunc(
      CASE r.frequency WHEN 'yearly' THEN 'year' ELSE 'month' END,
      r.start_date
    )::date;

    WHILE v_cursor <= p_today LOOP
      v_due := v_cursor + (r.day_of_month - 1);

      -- Only post once the day has actually arrived, and never past the end.
      IF v_due <= p_today
         AND v_due >= r.start_date
         AND (r.end_date IS NULL OR v_due <= r.end_date) THEN

        v_period := CASE r.frequency
                      WHEN 'yearly'    THEN to_char(v_cursor, 'YYYY')
                      WHEN 'quarterly' THEN to_char(v_cursor, 'YYYY') || '-Q' ||
                                            to_char(extract(quarter FROM v_cursor), 'FM9')
                      ELSE                  to_char(v_cursor, 'YYYY-MM')
                    END;

        INSERT INTO finance_entry (
          direction, amount_centimes, vat_centimes, entry_date, category,
          payment_method, description, company_id, reference, is_automatic,
          recorded_by_id, recurring_entry_id, period_key
        ) VALUES (
          r.direction, r.amount_centimes, r.vat_centimes, v_due, r.category,
          r.payment_method, r.description || ' — ' || v_period, r.company_id,
          NULL, true, r.created_by_id, r.id, v_period
        )
        ON CONFLICT (recurring_entry_id, period_key)
          WHERE recurring_entry_id IS NOT NULL DO NOTHING;

        IF FOUND THEN v_posted := v_posted + 1; END IF;
      END IF;

      v_cursor := (v_cursor + v_step)::date;
    END LOOP;
  END LOOP;

  RETURN v_posted;
END;
$function$;

-- app.next_document_number() has no guard either. It is NOT reachable today —
-- no server action calls it, only app.issue_document() does, and that is
-- guarded. Guarded anyway: this function hands out invoice numbers from a
-- row-locked counter, and the one property the whole numbering scheme rests on
-- is that a number is never taken without a document being issued. A caller who
-- could spin it would leave gaps an auditor would ask about, and "not reachable
-- today" is a statement about today's code.
CREATE OR REPLACE FUNCTION app.next_document_number(p_type text, p_year integer)
RETURNS TABLE (number text, seq integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_prefix text; v_seq integer;
BEGIN
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can assign a document number.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_prefix := CASE p_type
                WHEN 'devis'   THEN 'DEV'
                WHEN 'facture' THEN 'FAC'
                WHEN 'avoir'   THEN 'AVR'
              END;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'Unknown document type: %', p_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Row-locked counter, deliberately not a sequence: a sequence leaves a gap
  -- when a transaction rolls back, and these numbers must be gapless.
  INSERT INTO document_counter (doc_type, year, last_seq)
  VALUES (p_type, p_year, 0)
  ON CONFLICT (doc_type, year) DO NOTHING;

  SELECT last_seq + 1 INTO v_seq
    FROM document_counter
   WHERE doc_type = p_type AND year = p_year
     FOR UPDATE;

  UPDATE document_counter SET last_seq = v_seq
   WHERE doc_type = p_type AND year = p_year;

  number := format('%s-%s-%s', v_prefix, p_year, lpad(v_seq::text, 4, '0'));
  seq := v_seq;
  RETURN NEXT;
END;
$$;

-- The attachment delete policy names no entity_type, so on its face a
-- moderator could delete an invoice's attachments. In practice they cannot:
-- the SELECT policies hide money attachments from them, so the DELETE matches
-- no rows. That is safe by accident of visibility rather than by the rule that
-- is supposed to say so — and the two policies could drift apart. Say it here.
DROP POLICY IF EXISTS attachment_work_delete ON attachment;
CREATE POLICY attachment_work_delete ON attachment FOR DELETE
  USING (
    entity_type IN ('task','project','company','contact')
    AND (app.is_moderator() OR uploaded_by_id = app.current_user_id())
  );

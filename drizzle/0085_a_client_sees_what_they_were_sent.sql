-- =============================================================================
-- 0085 — A client sees what they were sent, and what they have paid.
--
-- Until now the portal showed no money at all: document, document_line and
-- document_payment carried only an administrator policy and the bootstrap one.
-- Amin asked for the portal to show a client their invoices and payments. This
-- is the first time money crosses the client boundary (0064), so it crosses
-- with the same three layers that boundary was built on:
--
--   1. GRANTS, and narrower than the table: COLUMN grants. A client reads the
--      columns that are printed on the document they received, and not the
--      ones that are ours — who created it, which deal or retainer it came
--      from, the note on a payment (a reversal's reason, "cheque bounced",
--      is written for us, not for them). A query for a column not on the list
--      fails outright rather than returning it.
--   2. ROWS. Only their own company (derived in the database, never taken
--      from the session), and only what has been ISSUED: a draft has no
--      number and was never sent, so a client never sees one, nor anything
--      cancelled. Lines and payments are visible only through a document the
--      client may see.
--   3. READ ONLY. No INSERT, UPDATE or DELETE is granted. A client cannot
--      record a payment, only see the ones we recorded.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Layer 1: grants, column by column
-- -----------------------------------------------------------------------------

GRANT SELECT (
  id, doc_type, status, number, number_year, number_seq, company_id,
  issue_date, due_date, vat_rate_bp, vat_exemption_reason,
  withholding, withholding_rate_bp, discount_centimes,
  total_excl_vat, total_vat, total_incl_vat, withheld, net_to_collect,
  client_name, client_legal_name, client_ice, client_if, client_rc,
  client_address, client_is_individual,
  subject, notes, payment_terms, payment_method, corrects_id,
  advance_expected_centimes, paid_at,
  issuer_bank_name, issuer_bank_rib, issuer_bank_iban, issuer_bank_swift,
  created_at
) ON document TO vixart_client;

GRANT SELECT (
  id, document_id, label, description, unit, unit_price_centimes, quantity_millis, position, created_at
) ON document_line TO vixart_client;

GRANT SELECT (
  id, document_id, amount_centimes, method, paid_on, reverses_id, created_at
) ON document_payment TO vixart_client;

-- -----------------------------------------------------------------------------
-- Layer 2: rows
-- -----------------------------------------------------------------------------

CREATE POLICY document_client_select ON document FOR SELECT TO vixart_client
  USING (
    company_id = app.current_client_company()
    AND status IN ('emis', 'paye')
  );

CREATE POLICY document_line_client_select ON document_line FOR SELECT TO vixart_client
  USING (EXISTS (
    SELECT 1 FROM document d
     WHERE d.id = document_line.document_id
       AND d.company_id = app.current_client_company()
       AND d.status IN ('emis', 'paye')
  ));

CREATE POLICY payment_client_select ON document_payment FOR SELECT TO vixart_client
  USING (EXISTS (
    SELECT 1 FROM document d
     WHERE d.id = document_payment.document_id
       AND d.company_id = app.current_client_company()
       AND d.status IN ('emis', 'paye')
  ));

COMMENT ON POLICY document_client_select ON document IS
  'A signed-in client reads their own company''s issued and paid documents. '
  'Never a draft, never a cancelled one, never another company''s.';

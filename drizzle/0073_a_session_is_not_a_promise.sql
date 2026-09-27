-- =============================================================================
-- 0073 — Turning an account off takes effect now, not in twelve hours.
--
-- From a source audit, and it is the same defect on both sides of the system.
--
-- Identity and role are established at sign-in and then carried in a signed JWT
-- for twelve hours. Every request puts those claims into the transaction, and
-- every policy trusts them — so `is_active` and `role` are read once, at the
-- door, and never again. Disabling somebody, or demoting an administrator,
-- changed a row that nothing downstream consults. The person kept working, with
-- the access they had when they signed in, until their token expired.
--
-- On the client side it is narrower and worse. `app.current_client_company()` is
-- the function EVERY client policy is written in terms of: it derives the company
-- from the contact, which is exactly right, and checks nothing else. So an
-- account we had deliberately turned off — a relationship ended, a contact who
-- left the company — carried on reading that company's projects and its support
-- conversation. `app.lookup_client_login` checks `is_active` and
-- `company.archived_at` at sign-in; nothing checked them afterwards.
--
-- The fix here is the client half, and it goes in this function rather than in
-- the portal's pages because this is the single thing the whole boundary hangs
-- off. Return NULL and every client policy evaluates false: no projects, no
-- messages, no attachments, no systems. One place, and it cannot be forgotten by
-- a page written later.
--
-- The staff half is in `withUser` (src/db/session.ts), which is the equivalent
-- chokepoint on that side: one transaction, one identity, re-read per request.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.current_client_company() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT c.company_id
    FROM contact c
    JOIN client_account a ON a.contact_id = c.id
    JOIN company co       ON co.id = c.company_id
   WHERE c.id = app.current_client_contact()
     -- The account, as it stands NOW. Turned off means turned off, on the next
     -- request rather than at the next sign-in.
     AND a.is_active
     -- And the relationship. A client whose company has been archived is a
     -- relationship that has ended; the portal should not outlive it.
     AND co.archived_at IS NULL;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.current_client_company() IS
  'The company of the signed-in client, looked up rather than accepted from the '
  'session — and re-checked on every request against the account being active '
  'and the company not archived. Returns NULL otherwise, which makes every '
  'client policy evaluate false. Guarded by its own narrowness: one column, for '
  'one id the caller already claimed.';

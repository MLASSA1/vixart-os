-- =============================================================================
-- 0068 — An email address identifies at most one client sign-in.
--
-- Found while testing the new one-submit account form: typing an address that
-- already had an account produced a SECOND company, a second contact and a
-- second account, with no complaint from anywhere. Nothing refused it because
-- `contact.email` is not unique — deliberately, and correctly: two people at a
-- client can share a shopfront address, and the same person can appear at two
-- companies over the years. Contacts are a directory, not a login table.
--
-- What makes it serious is what happens next. `app.lookup_client_login` selects
-- by `lower(email)` and takes `LIMIT 1` with no ORDER BY, so with two matching
-- accounts the row returned is whichever the planner happens to produce — and
-- that can change between one query and the next. A client would sign in and
-- see A COMPANY THAT IS NOT THEIRS, chosen by a query plan, with every policy
-- downstream working exactly as designed: the session would carry the other
-- contact's id, so the boundary would faithfully show them the wrong client's
-- projects and the wrong client's conversation.
--
-- It needed two accounts on one address to happen, which is why it had not.
-- The new form made that a single typo.
--
-- Two changes, because either alone leaves the other case open:
--
--   1. the situation cannot arise — a trigger refuses the second account;
--   2. if it somehow exists anyway (a restore from before this, an owner
--      writing directly), sign-in REFUSES rather than guesses. A client who
--      cannot sign in asks us why. A client silently placed inside another
--      company's portal does not.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.client_account_one_per_address()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER because it must see every account to answer the question, and the
-- caller may be the application role under its own policies. EXEMPT from the
-- definer guard by argument: it takes none, reads nothing the caller names, and
-- returns no data — it either raises or lets the write through.
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_email text;
  v_clash text;
BEGIN
  SELECT lower(trim(c.email)) INTO v_email
    FROM contact c WHERE c.id = NEW.contact_id;

  -- No address is a different problem, and one the action already refuses:
  -- an account whose password cannot be sent anywhere.
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION
      'That contact has no email address, so the invitation could not be sent.'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT co.name INTO v_clash
    FROM client_account a
    JOIN contact c  ON c.id = a.contact_id
    JOIN company co ON co.id = c.company_id
   WHERE lower(trim(c.email)) = v_email
     AND a.contact_id <> NEW.contact_id
   LIMIT 1;

  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION
      'There is already a portal account on %, under %. One address, one sign-in — otherwise signing in cannot tell the two apart.',
      v_email, v_clash
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.client_account_one_per_address() IS
  'Refuses a second portal account on an address that already has one. '
  'EXEMPT from the definer-caller check: takes no arguments, returns no data, '
  'and its only effect is to raise or to allow the write.';
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_account_one_per_address ON client_account;
--> statement-breakpoint
CREATE TRIGGER client_account_one_per_address
  BEFORE INSERT OR UPDATE OF contact_id ON client_account
  FOR EACH ROW EXECUTE FUNCTION app.client_account_one_per_address();
--> statement-breakpoint

/*
 * Sign-in refuses an ambiguous address rather than picking one.
 *
 * The trigger above stops this arising from now on. This is for the case it
 * already has, or arrives in a restore: two rows on one address means we do not
 * know who is signing in, and the only safe answer to that is none.
 *
 * Written as a guard on the count rather than an ORDER BY, because a
 * deterministic wrong answer is still the wrong answer — it would just fail the
 * same way every time instead of intermittently.
 */
CREATE OR REPLACE FUNCTION app.lookup_client_login(p_email text)
RETURNS TABLE (
  contact_id    uuid,
  company_id    uuid,
  full_name     text,
  email         text,
  company_name  text,
  password_hash text,
  must_change_password boolean,
  is_active     boolean,
  initial_password_expires_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_matches integer;
BEGIN
  SELECT count(*) INTO v_matches
    FROM client_account a
    JOIN contact c ON c.id = a.contact_id
   WHERE lower(trim(c.email)) = lower(trim(p_email));

  IF v_matches <> 1 THEN
    -- Nothing, for none and for many alike. A sign-in screen that answered
    -- differently for "no such account" and "two of them" would be telling an
    -- outsider which addresses we hold.
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.company_id, c.full_name, c.email, co.name,
         a.password_hash, a.must_change_password,
         -- A client whose company has been archived cannot sign in: the
         -- relationship is over, and the account should not outlive it.
         (a.is_active AND co.archived_at IS NULL),
         a.initial_password_expires_at
    FROM client_account a
    JOIN contact c  ON c.id = a.contact_id
    JOIN company co ON co.id = c.company_id
   WHERE lower(trim(c.email)) = lower(trim(p_email));
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.lookup_client_login(text) IS
  'Sign-in path for the client portal. Runs before any session exists, like '
  'app.lookup_login. Returns one row by email, and NOTHING when the address '
  'matches more than one account — guessing would sign somebody in to a '
  'company that is not theirs. EXEMPT from the definer-caller check: there is '
  'no caller to check, which is the point of it.';
--> statement-breakpoint

/*
 * THE GRANT, AND THE MISTAKE THAT MADE IT NECESSARY TO WRITE DOWN.
 *
 * This first said REVOKE FROM PUBLIC and granted only `vixart_app`, which was
 * tidy and which broke client sign-in completely — caught on a running portal,
 * one command before it would have been deployed.
 *
 * The reason is a default nobody states: PostgreSQL grants EXECUTE on a new
 * function to PUBLIC. 0064 revoked every function in this schema from
 * `vixart_client` by name, but a REVOKE aimed at a role does not touch
 * PUBLIC's grant — so the portal had been reaching this function through
 * PUBLIC the whole time, invisibly, and nothing said so.
 *
 * Naming both roles is what that should have been from the start: it is
 * tighter than the PUBLIC default it replaces, and it is now written where the
 * next person looks.
 */
REVOKE ALL ON FUNCTION app.lookup_client_login(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lookup_client_login(text) TO vixart_app;
--> statement-breakpoint
-- The portal signs a client in ON THE CLIENT ROLE'S CONNECTION (see src/auth.ts):
-- there is no session yet, and the container holds no other credentials.
GRANT EXECUTE ON FUNCTION app.lookup_client_login(text) TO vixart_client;

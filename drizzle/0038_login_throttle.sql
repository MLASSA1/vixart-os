-- VIXART OS — slow down password guessing.
--
-- The sign-in page is now on the public internet, in front of the agency's
-- books, its client list and its invoices. Until this migration a password
-- could be guessed as fast as the network allowed: nothing counted failures,
-- nothing ever refused. bcrypt at cost 12 is roughly 250 ms per attempt, which
-- sounds slow until you notice it is four guesses a second, forever, against
-- an account whose address is printed on every invoice the agency sends.
--
-- fail2ban guards ssh, postfix and dovecot on this machine. It does not watch
-- the application, and it never saw a single one of these attempts.
--
-- Two counters, because they fail differently:
--
--   by EMAIL — stops one account being ground down, including from a thousand
--              different addresses, which is what a botnet is.
--   by IP    — stops one source spraying many accounts, which is what a
--              credential-stuffing list looks like.
--
-- Neither ever locks an account permanently. A lockout that needs an
-- administrator to lift it is a denial of service anyone can trigger against
-- Amin by typing his address wrong eight times. These windows expire on their
-- own.

CREATE TABLE login_attempt (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  ip         text,
  ok         boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

-- Every lookup is "failures for this key since a moment ago", so the index
-- leads with time.
CREATE INDEX login_attempt_email ON login_attempt (lower(email), at DESC) WHERE NOT ok;
CREATE INDEX login_attempt_ip    ON login_attempt (ip, at DESC) WHERE NOT ok;
CREATE INDEX login_attempt_age   ON login_attempt (at);

ALTER TABLE login_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempt FORCE ROW LEVEL SECURITY;

-- Nobody reads this through the application. It is written by the sign-in path
-- and read by the two functions below, both SECURITY DEFINER; an admin who
-- wants to see it uses psql. There is deliberately no screen for it: a list of
-- which addresses are being tried is itself worth stealing.
CREATE POLICY login_attempt_bootstrap ON login_attempt
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- ---------------------------------------------------------------------------
-- Is this sign-in allowed to proceed?
--
-- SECURITY DEFINER because it runs before anyone is authenticated — there is
-- no session yet, so there is no role for RLS to evaluate. It takes no caller
-- identity and returns only a number, so it grants nothing: the same reasoning
-- that exempts app.lookup_login.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.login_retry_after(p_email text, p_ip text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email_fails integer;
  v_ip_fails    integer;
  v_last        timestamptz;
BEGIN
  -- Generous for a person who has forgotten which password they used,
  -- punishing for a script: eight tries buys a fifteen minute wait.
  SELECT count(*), max(at) INTO v_email_fails, v_last
    FROM login_attempt
   WHERE lower(email) = lower(trim(p_email))
     AND NOT ok
     AND at > now() - interval '15 minutes';

  IF v_email_fails >= 8 THEN
    RETURN greatest(1, ceil(extract(epoch FROM (v_last + interval '15 minutes' - now())))::integer);
  END IF;

  IF p_ip IS NOT NULL THEN
    SELECT count(*), max(at) INTO v_ip_fails, v_last
      FROM login_attempt
     WHERE ip = p_ip AND NOT ok AND at > now() - interval '15 minutes';

    -- Higher than the per-account limit: the whole agency may sit behind one
    -- office address, and a bad morning for five people must not lock the
    -- building out.
    IF v_ip_fails >= 30 THEN
      RETURN greatest(1, ceil(extract(epoch FROM (v_last + interval '15 minutes' - now())))::integer);
    END IF;
  END IF;

  RETURN 0;   -- go ahead
END;
$$;

-- ---------------------------------------------------------------------------
-- Record the outcome, and keep the table from growing forever.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.record_login_attempt(p_email text, p_ip text, p_ok boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO login_attempt (email, ip, ok) VALUES (left(coalesce(p_email,''), 320), p_ip, p_ok);

  -- A successful sign-in clears that account's failures: the person proved who
  -- they are, and should not still be serving out a sentence for forgetting.
  IF p_ok THEN
    DELETE FROM login_attempt
     WHERE lower(email) = lower(trim(p_email)) AND NOT ok;
  END IF;

  -- Cheap opportunistic trim, roughly one run in fifty, so no scheduled job is
  -- needed and no single sign-in pays for the cleanup.
  IF random() < 0.02 THEN
    DELETE FROM login_attempt WHERE at < now() - interval '30 days';
  END IF;
END;
$$;

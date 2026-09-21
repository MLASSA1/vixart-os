-- =============================================================================
-- 0064 — The client boundary.
--
-- Until now every account in this system belonged to somebody VIXART employs,
-- and the policies say so: SEVENTEEN of them admit "any authenticated person"
-- to company, project, contact, task, thread, activity, app_user, interaction,
-- comment, effort_log, prep, equipment, capacity, service, attachment and
-- fiscal_rate. That was correct. It stops being correct the moment a client
-- can sign in.
--
-- So a client is NOT an app_user. It is a `contact` — a row that already
-- exists, already belongs to exactly one company — with a login attached. That
-- choice is the whole design:
--
--   * `app.is_real_person()` requires a row in app_user. A client has none, so
--     it is false for them, and every policy built on it stays true to what it
--     was written to mean.
--   * `app.is_authenticated()` reads the staff role GUC. A client session never
--     sets it, so it is false for them too.
--
-- A shadow app_user per client would have been less work and is precisely the
-- thing that must not exist: a row that could one day satisfy is_real_person()
-- because somebody flipped is_assignable to tidy a list.
--
-- THREE INDEPENDENT LAYERS, so that no single mistake opens the door:
--
--   1. GRANTS. The client role is granted SELECT on a short list of tables and
--      nothing else. Grants are checked BEFORE policies, so a permissive
--      policy on a table it cannot select from changes nothing. Crucially it
--      gets NO default privileges, so a table added next year is invisible to
--      clients until somebody grants it on purpose.
--   2. THE EXISTING POLICIES evaluate false for a client session, as above.
--   3. NEW POLICIES, written TO vixart_client, granting only their own row,
--      their own company's projects, and their own support conversation.
--
-- Remove any one and two remain.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The role
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vixart_client') THEN
    -- No password here: `scripts/apply-grants.ts` sets it from the environment,
    -- the same way it does for the application role. A password in a migration
    -- is a password in the repository.
    CREATE ROLE vixart_client LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Who the session is
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_client_contact() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.client_contact_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app.current_client_contact() IS
  'The contact this client session belongs to, from the session GUC. Never set '
  'for a staff session.';

/*
 * The company follows FROM THE DATABASE, not from the session.
 *
 * It would be quicker to have the portal set a company id alongside the
 * contact id and read it straight back. It would also mean the portal decides
 * which company a client belongs to — and the whole point of this boundary is
 * that a mistake in the portal cannot widen it. The contact id is claimed; the
 * company is derived.
 *
 * SECURITY DEFINER because the client role cannot read `contact` freely: it is
 * allowed its own row and no other, and that rule is written below in terms of
 * this function.
 */
CREATE OR REPLACE FUNCTION app.current_client_company() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT c.company_id FROM contact c WHERE c.id = app.current_client_contact();
$$;

COMMENT ON FUNCTION app.current_client_company() IS
  'The company of the signed-in client, looked up rather than accepted from the '
  'session. Guarded by its own narrowness: one column, for one id, that the '
  'caller already claimed.';

CREATE OR REPLACE FUNCTION app.is_client() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_client_contact() IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- The login
-- -----------------------------------------------------------------------------

CREATE TABLE client_account (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One login per contact. A company with three contacts can have three
  -- logins; a contact cannot have two.
  contact_id         uuid NOT NULL UNIQUE REFERENCES contact(id) ON DELETE CASCADE,
  password_hash      text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  /*
   * Amin's decision, taken with the objection on the table: the first password
   * is generated here and emailed. This column is the mitigation that does not
   * change his flow — an invitation that is never used stops working, so a
   * forgotten message in an inbox is not a permanent key to the account.
   * Cleared the moment they choose their own password.
   */
  initial_password_expires_at timestamptz,
  is_active          boolean NOT NULL DEFAULT true,
  last_sign_in_at    timestamptz,
  created_by_id      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE client_account IS
  'A login attached to a contact. Deliberately not a row in app_user: every '
  'policy that says "any authenticated person" means a member of staff, and '
  'app_user is what that phrase resolves to.';

CREATE INDEX client_account_contact_idx ON client_account (contact_id);

ALTER TABLE client_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_account FORCE ROW LEVEL SECURITY;

CREATE POLICY client_account_bootstrap ON client_account
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- Staff: moderators and admins manage client logins. A member can see that one
-- exists — they talk to these people — but cannot create or disable one.
CREATE POLICY client_account_select ON client_account FOR SELECT
  USING (app.is_real_person());

CREATE POLICY client_account_write ON client_account FOR INSERT
  WITH CHECK (app.is_moderator());

CREATE POLICY client_account_update ON client_account FOR UPDATE
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());

CREATE POLICY client_account_delete ON client_account FOR DELETE
  USING (app.is_admin());

CREATE TRIGGER client_account_touch_updated_at
  BEFORE UPDATE ON client_account
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- A client can write a message
--
-- `message.author_id` is NOT NULL and references app_user, so as the schema
-- stood a client could not author anything at all. Authorship becomes one of
-- two things — a member of staff, or a contact — and exactly one of them.
-- -----------------------------------------------------------------------------

ALTER TABLE message ALTER COLUMN author_id DROP NOT NULL;

ALTER TABLE message ADD COLUMN author_contact_id uuid
  REFERENCES contact(id) ON DELETE RESTRICT;

ALTER TABLE message ADD CONSTRAINT message_one_author CHECK (
  (author_id IS NOT NULL AND author_contact_id IS NULL)
  OR (author_id IS NULL AND author_contact_id IS NOT NULL)
);

COMMENT ON COLUMN message.author_contact_id IS
  'Set when a client wrote it. Exactly one of author_id and author_contact_id '
  'is filled — see message_one_author.';

CREATE INDEX message_by_contact ON message (author_contact_id)
  WHERE author_contact_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- The support conversation
-- -----------------------------------------------------------------------------

ALTER TABLE thread DROP CONSTRAINT IF EXISTS thread_kind_valid;
ALTER TABLE thread ADD CONSTRAINT thread_kind_valid
  CHECK (kind IN ('general', 'company', 'project', 'dm', 'support'));

/*
 * And the shape of the row has to admit it too.
 *
 * `thread_target_matches_kind` enumerates which columns each kind may fill —
 * a support thread hangs off a company and nothing else. Adding the kind to
 * `thread_kind_valid` without adding it here would let the kind exist and
 * refuse every row of it, which is the kind of half-migration that passes a
 * migration run and fails the first time anybody uses the feature.
 */
ALTER TABLE thread DROP CONSTRAINT IF EXISTS thread_target_matches_kind;
ALTER TABLE thread ADD CONSTRAINT thread_target_matches_kind CHECK (
     (kind = 'general' AND company_id IS NULL     AND project_id IS NULL
        AND participant_a IS NULL AND participant_b IS NULL)
  OR (kind = 'company' AND company_id IS NOT NULL AND project_id IS NULL
        AND participant_a IS NULL AND participant_b IS NULL)
  OR (kind = 'support' AND company_id IS NOT NULL AND project_id IS NULL
        AND participant_a IS NULL AND participant_b IS NULL)
  OR (kind = 'project' AND project_id IS NOT NULL AND company_id IS NULL
        AND participant_a IS NULL AND participant_b IS NULL)
  OR (kind = 'dm'      AND company_id IS NULL     AND project_id IS NULL
        AND participant_a IS NOT NULL AND participant_b IS NOT NULL
        AND participant_a <> participant_b)
);

-- One per company, and only one. A partial index rather than a constraint
-- because `company` threads use the same column for a different kind.
CREATE UNIQUE INDEX thread_one_support_per_company ON thread (company_id)
  WHERE kind = 'support';

/*
 * Staff must be able to see it.
 *
 * `thread_select` lists the kinds a member of staff may open, and a kind that
 * is not on the list is invisible — so without this line the support thread
 * would exist, the client could write in it, and nobody at VIXART would ever
 * see a word of it.
 */
DROP POLICY IF EXISTS thread_select ON thread;
CREATE POLICY thread_select ON thread FOR SELECT USING (
  (
    app.is_real_person() AND (
         (kind = 'general')
      OR (kind = 'company'  AND EXISTS (SELECT 1 FROM company c WHERE c.id = thread.company_id))
      OR (kind = 'project'  AND EXISTS (SELECT 1 FROM project p WHERE p.id = thread.project_id))
      OR (kind = 'support'  AND EXISTS (SELECT 1 FROM company c WHERE c.id = thread.company_id))
      OR (kind = 'dm' AND app.current_user_id() IN (participant_a, participant_b))
    )
  )
  OR
  -- The client's own support thread, and nothing else. Not the company
  -- channel their account manager uses to discuss them, which is a different
  -- thread of a different kind.
  (kind = 'support' AND company_id = app.current_client_company())
);

-- -----------------------------------------------------------------------------
-- What a client may read and write
--
-- Every policy below names `app.current_client_company()`, which is derived
-- from the database rather than claimed by the session. A client with no
-- contact id set matches nothing, because the function returns NULL and
-- `column = NULL` is never true.
-- -----------------------------------------------------------------------------

CREATE POLICY company_client_select ON company FOR SELECT TO vixart_client
  USING (id = app.current_client_company());

CREATE POLICY contact_client_select ON contact FOR SELECT TO vixart_client
  -- Their own record. NOT their colleagues': a contact list is worth something
  -- to whoever takes it, and they did not ask us to hold it for them.
  USING (id = app.current_client_contact());

CREATE POLICY project_client_select ON project FOR SELECT TO vixart_client
  USING (company_id = app.current_client_company() AND archived_at IS NULL);

CREATE POLICY service_client_select ON service FOR SELECT TO vixart_client
  -- The catalogue. Nothing here is specific to one client.
  USING (is_active);

CREATE POLICY thread_client_select ON thread FOR SELECT TO vixart_client
  USING (kind = 'support' AND company_id = app.current_client_company());

CREATE POLICY message_client_select ON message FOR SELECT TO vixart_client
  USING (EXISTS (
    SELECT 1 FROM thread t
     WHERE t.id = message.thread_id
       AND t.kind = 'support'
       AND t.company_id = app.current_client_company()
  ));

CREATE POLICY message_client_insert ON message FOR INSERT TO vixart_client
  WITH CHECK (
    -- Written by them, in their own thread, and attributed to them. All three,
    -- because any one on its own is a way to write as somebody else.
    author_contact_id = app.current_client_contact()
    AND author_id IS NULL
    AND EXISTS (
      SELECT 1 FROM thread t
       WHERE t.id = message.thread_id
         AND t.kind = 'support'
         AND t.company_id = app.current_client_company()
    )
  );

/*
 * A moderator can take back something a client posted.
 *
 * Not editing — withdrawal, which leaves the tombstone the rest of chat
 * leaves. Without it a wrong attachment or somebody's personal details posted
 * into a support thread would stay there for ever, because the client cannot
 * withdraw and staff could not touch a message they did not write.
 */
DROP POLICY IF EXISTS message_update ON message;
CREATE POLICY message_update ON message FOR UPDATE
  USING (
    (author_id IS NOT NULL AND author_id = app.current_user_id())
    OR (author_contact_id IS NOT NULL AND app.is_moderator()
        AND EXISTS (SELECT 1 FROM thread t
                     WHERE t.id = message.thread_id AND t.kind = 'support'))
  )
  WITH CHECK (
    (author_id IS NOT NULL AND author_id = app.current_user_id())
    OR (author_contact_id IS NOT NULL AND app.is_moderator())
  );

-- -----------------------------------------------------------------------------
-- Signing in
--
-- Mirrors `app.lookup_login` for staff: at sign-in time there is no session
-- yet, so RLS has no identity to evaluate and the client role can read nothing.
-- Narrow on purpose — one row, by email, and it returns the hash for the
-- application to compare rather than accepting a password to check.
-- -----------------------------------------------------------------------------

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
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT c.id, c.company_id, c.full_name, c.email, co.name,
         a.password_hash, a.must_change_password,
         -- A client whose company has been archived cannot sign in: the
         -- relationship is over, and the account should not outlive it.
         (a.is_active AND co.archived_at IS NULL),
         a.initial_password_expires_at
    FROM client_account a
    JOIN contact c  ON c.id = a.contact_id
    JOIN company co ON co.id = c.company_id
   WHERE lower(c.email) = lower(p_email)
   LIMIT 1;
$$;

COMMENT ON FUNCTION app.lookup_client_login(text) IS
  'Sign-in path for the client portal. Runs before any session exists, like '
  'app.lookup_login. Returns one row by email and nothing about anybody else.';

-- -----------------------------------------------------------------------------
-- The grants — the layer that does not depend on any policy being right
-- -----------------------------------------------------------------------------

GRANT CONNECT ON DATABASE vixart TO vixart_client;
GRANT USAGE ON SCHEMA public TO vixart_client;
GRANT USAGE ON SCHEMA app TO vixart_client;
REVOKE CREATE ON SCHEMA public FROM vixart_client;

-- Start from nothing. This runs on every migration of this file, and it is the
-- line that makes the list below exhaustive rather than additive.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vixart_client;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM vixart_client;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM vixart_client;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM vixart_client;

-- Read: the short list, and it is short on purpose.
GRANT SELECT ON company, contact, project, service, thread, message TO vixart_client;

-- Write: one table, one column set, one policy deciding.
GRANT INSERT ON message TO vixart_client;

-- The identity functions the policies above are written in terms of.
GRANT EXECUTE ON FUNCTION
  app.current_client_contact(), app.current_client_company(), app.is_client()
  TO vixart_client;

/*
 * DELIBERATELY NO DEFAULT PRIVILEGES.
 *
 * The application role has `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT,
 * UPDATE, DELETE ON TABLES`, so a table created next year is reachable by the
 * internal application the moment it exists. The client role gets no such
 * thing: a new table is invisible to clients until somebody writes a GRANT for
 * it on purpose, in a migration, where it can be read and argued with.
 *
 * This is the difference between a boundary that holds and one that held on
 * the day it was written.
 */
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM vixart_client;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM vixart_client;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM vixart_client;

-- The migration journal is not the client's business either.
REVOKE ALL ON SCHEMA drizzle FROM vixart_client;

-- -----------------------------------------------------------------------------
-- Bookkeeping the client is not allowed to do for itself
--
-- Inserting a message fires a trigger that bumps `thread.updated_at` so the
-- channel list can sort by recency. The client role has no UPDATE on `thread`
-- and should not: an UPDATE grant is an UPDATE grant, and the column list is
-- not the part anybody checks later.
--
-- So the trigger stops borrowing the caller's rights. It runs as the owner,
-- which is safe here in a way worth stating: it writes one timestamp, on the
-- parent of a row that row level security has ALREADY admitted, and it takes
-- no argument from anybody. There is nothing to aim it at.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.touch_thread_on_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE thread SET updated_at = now() WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.touch_thread_on_message() IS
  'Sorts the channel list by recency. SECURITY DEFINER so a client can post '
  'without holding UPDATE on thread: it writes one timestamp on the parent of '
  'a row RLS has already allowed, and takes no argument.';

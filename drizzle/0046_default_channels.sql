-- =============================================================================
-- 0046 — Channels that are already there.
--
-- Chat shipped with an empty table and a "Start the thread" button, so having
-- a conversation about a project meant remembering to create somewhere to have
-- it. Nobody did: `thread` holds zero rows. A channel list is only worth
-- looking at if the channels exist before anyone asks for them.
--
-- Three changes, one idea:
--
--   General exists because this migration creates it.
--   A project or a client opens its channel from a trigger, at the moment the
--   record is created, whichever screen created it.
--   Everything already in the database is backfilled.
--
-- "Client" means status = 'client'. A lead, a prospect and a dormant company
-- get nothing automatic — that is the same line the sidebar already draws
-- between Clients and Leads, and a channel per lead would bury the ones that
-- matter in the one list that has to stay readable. A company that becomes a
-- client gets its channel then, from the same trigger. Anything else can still
-- be opened by hand.
-- =============================================================================

ALTER TABLE thread ADD COLUMN is_default boolean NOT NULL DEFAULT false;
--> statement-breakpoint

COMMENT ON COLUMN thread.is_default IS
  'Opened automatically for its parent. Separates the channel that is always there from one somebody opened alongside it.';
--> statement-breakpoint

-- One automatic channel per thing. These are what make both the triggers and
-- the backfill idempotent: everything below inserts with ON CONFLICT DO
-- NOTHING and leans on the index to decide whether there is a conflict.
--
-- Unique on `kind` filtered to general-and-default means at most one row can
-- satisfy it, which is the intent: exactly one General.
CREATE UNIQUE INDEX thread_one_general
  ON thread (kind) WHERE kind = 'general' AND is_default;
--> statement-breakpoint

CREATE UNIQUE INDEX thread_one_per_project
  ON thread (project_id) WHERE is_default AND project_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX thread_one_per_company
  ON thread (company_id) WHERE is_default AND company_id IS NOT NULL;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Who a channel nobody opened belongs to.
--
-- `created_by_id` is NOT NULL and references a real account, and the seed, this
-- migration and the backfill all run with nobody signed in. Rather than invent
-- a system account — which would then show up in every picker and have to be
-- excluded from every query — an unattended channel is attributed to the
-- longest-standing administrator.
--
-- SECURITY INVOKER, like everything else added since 0044: it reads `app_user`,
-- whose SELECT policy already allows any authenticated session, so there is
-- nothing here that needs to step around a policy.
-- -----------------------------------------------------------------------------

CREATE FUNCTION app.channel_author() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_id uuid;
BEGIN
  v_id := app.current_user_id();
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT id INTO v_id
    FROM app_user
   WHERE role = 'admin' AND is_active
   ORDER BY created_at
   LIMIT 1;

  RETURN v_id;
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Opening a channel with its parent.
--
-- AFTER INSERT, so the parent row exists and the foreign key holds. The insert
-- runs under the policies of whoever created the record — `thread_insert`
-- wants a real person writing their own id, which is exactly what is happening
-- — so no part of this steps around row level security.
--
-- If there is no author to name at all the record is still created and the
-- channel is not. A project that cannot be created because chat could not name
-- a channel author would be a poor trade.
-- -----------------------------------------------------------------------------

CREATE FUNCTION app.open_project_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_author uuid := app.channel_author();
BEGIN
  IF v_author IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO thread (kind, title, project_id, created_by_id, is_default)
  VALUES ('project', NEW.name, NEW.id, v_author, true)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER project_opens_channel
  AFTER INSERT ON project
  FOR EACH ROW EXECUTE FUNCTION app.open_project_channel();
--> statement-breakpoint

-- Fires on creation, and again if a prospect is promoted. `UPDATE OF status`
-- narrows it to the one column that can change the answer.
CREATE FUNCTION app.open_company_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_author uuid;
BEGIN
  IF NEW.status <> 'client'::client_status THEN
    RETURN NEW;
  END IF;

  v_author := app.channel_author();
  IF v_author IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO thread (kind, title, company_id, created_by_id, is_default)
  VALUES ('company', NEW.name, NEW.id, v_author, true)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER company_opens_channel
  AFTER INSERT OR UPDATE OF status ON company
  FOR EACH ROW EXECUTE FUNCTION app.open_company_channel();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Keeping the name honest.
--
-- A channel named after a project that has since been renamed sends people to
-- the wrong conversation. So the rename follows — but ONLY while the channel
-- still carries the name it was given. The moment someone has titled it
-- themselves it is theirs, and an edit upstream does not overwrite it.
-- -----------------------------------------------------------------------------

CREATE FUNCTION app.rename_project_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE thread SET title = NEW.name
   WHERE project_id = NEW.id AND is_default AND title = OLD.name;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER project_renames_channel
  AFTER UPDATE OF name ON project
  FOR EACH ROW WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION app.rename_project_channel();
--> statement-breakpoint

CREATE FUNCTION app.rename_company_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE thread SET title = NEW.name
   WHERE company_id = NEW.id AND is_default AND title = OLD.name;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER company_renames_channel
  AFTER UPDATE OF name ON company
  FOR EACH ROW WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION app.rename_company_channel();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The backfill.
--
-- The first migration in this project to write business rows, so it is also
-- the first to need the bootstrap flag: `thread` is FORCE ROW LEVEL SECURITY,
-- which applies to the owner too, and nobody is signed in here. Set explicitly
-- rather than with SET LOCAL, so it behaves the same whether or not the runner
-- wraps the file in a transaction, and turned off again immediately.
-- -----------------------------------------------------------------------------

SELECT set_config('app.bootstrap', 'on', false);
--> statement-breakpoint

INSERT INTO thread (kind, title, created_by_id, is_default)
SELECT 'general', 'General', app.channel_author(), true
 WHERE app.channel_author() IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO thread (kind, title, project_id, created_by_id, is_default)
SELECT 'project', p.name, p.id, app.channel_author(), true
  FROM project p
 WHERE app.channel_author() IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO thread (kind, title, company_id, created_by_id, is_default)
SELECT 'company', c.name, c.id, app.channel_author(), true
  FROM company c
 WHERE c.status = 'client'
   AND app.channel_author() IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

SELECT set_config('app.bootstrap', 'off', false);

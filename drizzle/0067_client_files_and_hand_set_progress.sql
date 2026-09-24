-- =============================================================================
-- 0067 — A client can send a photograph, and progress can be moved by hand.
--
-- Two things Amin asked for, and they share a migration because they share a
-- reason: the portal is now the surface a client actually uses, and it was
-- missing the two most ordinary things anybody does with a supplier — send a
-- picture of the problem, and be told how far along the work is.
--
-- PART ONE — attachments across the boundary.
--
-- `attachment` had policies for message attachments already, and both are
-- written `app.is_real_person()`: staff only. That was right when the only
-- people in a thread were colleagues. A support thread has somebody outside
-- the company in it, and they could neither see a file we sent nor send one.
--
-- The write side is the careful half. A client may attach only to a message
-- they wrote themselves — checked against `message.author_contact_id`, not
-- against anything the browser sends — which means a client cannot bolt a file
-- onto a message from us and make it look like ours.
--
-- PART TWO — progress that a person can set.
--
-- `app.project_progress` counted completed tasks. That number is honest and it
-- is frequently wrong for the reader: a project the team runs out of a shared
-- document has no tasks at all, so a client watching a film being made was
-- shown nothing happening. Amin and Mohamed Amine wanted a number they could
-- move.
--
-- So an override, nullable, and null means "keep counting tasks". Not a
-- replacement: the count stays and stays visible internally, so the two
-- numbers can be compared and a hand-set figure that has drifted from reality
-- is something somebody can see rather than something that quietly replaced
-- the truth.
--
-- Who may move it: `project_update` has been `app.is_moderator()` since 0006,
-- so writing to a project has ALWAYS been admin-or-moderator — which today is
-- Amin and Mohamed Amine. His rule was already true; what was missing was the
-- column, not the restriction.
--
-- The trigger below is therefore a SECOND lock, and it earns its place two
-- ways. It stamps who moved the figure and when, which nothing else records.
-- And it is what still holds on the day `project_update` is widened to let a
-- member edit a project's dates — a reasonable thing to want, and one that
-- would otherwise hand them the number a client reads as a side effect.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PART ONE — a client's side of the file store
-- -----------------------------------------------------------------------------

CREATE POLICY attachment_client_select ON attachment FOR SELECT TO vixart_client
  USING (
    entity_type = 'message'
    AND EXISTS (
      SELECT 1
        FROM message m
        JOIN thread t ON t.id = m.thread_id
       WHERE m.id = attachment.entity_id
         AND t.kind = 'support'
         -- Derived from the session's contact inside the database (0064), so
         -- the portal cannot widen it.
         AND t.company_id = app.current_client_company()
    )
  );
--> statement-breakpoint

CREATE POLICY attachment_client_insert ON attachment FOR INSERT TO vixart_client
  WITH CHECK (
    entity_type = 'message'
    -- A client is not an app_user. Anything else here would be a claim that a
    -- member of staff uploaded it.
    AND uploaded_by_id IS NULL
    AND EXISTS (
      SELECT 1
        FROM message m
        JOIN thread t ON t.id = m.thread_id
       WHERE m.id = attachment.entity_id
         -- Their OWN message. Without this a client could attach a file to
         -- something we wrote, and the conversation would show our name above
         -- their document.
         AND m.author_contact_id = app.current_client_contact()
         AND t.kind = 'support'
         AND t.company_id = app.current_client_company()
    )
  );
--> statement-breakpoint

-- No DELETE and no UPDATE, deliberately. A file in a conversation is part of
-- what was said; taking it back is a withdrawal, which is a moderator's doing
-- and already exists for the message that carries it.
GRANT SELECT, INSERT ON attachment TO vixart_client;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- PART TWO — progress somebody sets
-- -----------------------------------------------------------------------------

ALTER TABLE project
  ADD COLUMN IF NOT EXISTS progress_override   smallint,
  ADD COLUMN IF NOT EXISTS progress_set_by_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS progress_set_at     timestamptz;
--> statement-breakpoint

-- A percentage, or nothing. Not 0..1 and not a count: the number a client
-- reads is a percentage, and storing it as one means nobody has to remember
-- which of three conventions this column uses.
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_progress_override_range;
--> statement-breakpoint
ALTER TABLE project ADD CONSTRAINT project_progress_override_range
  CHECK (progress_override IS NULL OR progress_override BETWEEN 0 AND 100);
--> statement-breakpoint

COMMENT ON COLUMN project.progress_override IS
  'Percentage shown to the client instead of the task count. NULL means keep '
  'counting tasks. Only admin or moderator may set it (trigger below).';
--> statement-breakpoint

/*
 * Who may move the number.
 *
 * A trigger rather than a column-level grant, because the rule is not "may
 * this role write to project" — a member edits a project's dates and
 * description all day. It is "may this person change the figure a client
 * reads", which is narrower than any grant can express.
 *
 * Bootstrap is exempt: the seed and the migration runner have no identity to
 * check, and a restore that refused to carry these values would lose them.
 */
CREATE OR REPLACE FUNCTION app.project_progress_is_management()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER on purpose: it must see the caller's own role, which is the whole
-- question it is asking.
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.progress_override IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.progress_override IS NOT DISTINCT FROM OLD.progress_override THEN
    -- Untouched. Every other edit to a project passes straight through.
    RETURN NEW;
  END IF;

  IF NOT app.is_bootstrap() AND NOT app.is_moderator() THEN
    RAISE EXCEPTION
      'Only Amin or a work moderator can change the progress a client sees.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Stamped here rather than trusted from the caller, so the record of who
  -- moved it cannot be written by whoever moved it.
  IF app.is_bootstrap() THEN
    -- Keep whatever a restore is carrying.
    NEW.progress_set_at := coalesce(NEW.progress_set_at, now());
  ELSE
    NEW.progress_set_by_id := app.current_user_id();
    NEW.progress_set_at    := now();
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS project_progress_is_management ON project;
--> statement-breakpoint
CREATE TRIGGER project_progress_is_management
  BEFORE INSERT OR UPDATE OF progress_override ON project
  FOR EACH ROW EXECUTE FUNCTION app.project_progress_is_management();
--> statement-breakpoint

/*
 * The progress a page reads, now with the percentage decided in one place.
 *
 * Dropped and recreated rather than replaced, because the return type is
 * changing and CREATE OR REPLACE cannot do that.
 *
 * `percent` exists so the rule "a hand-set figure wins" has exactly one home.
 * Computing it in the portal and again on the internal page is how the two
 * come to disagree, and the one that would be wrong is the one the client
 * reads.
 *
 * Still SECURITY DEFINER and still guarded, for the reason 0065 gives: the
 * client role cannot read `task` at all, and a definer function that takes an
 * id is a way to ask questions about rows you were never shown.
 */
DROP FUNCTION IF EXISTS app.project_progress(uuid);
--> statement-breakpoint

CREATE FUNCTION app.project_progress(p_project uuid)
RETURNS TABLE (done integer, total integer, percent integer, by_hand boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed  boolean;
  v_manual smallint;
BEGIN
  SELECT
    (app.current_user_id() IS NOT NULL AND app.is_real_person()
       AND EXISTS (SELECT 1 FROM project WHERE id = p_project))
    OR
    (app.is_client() AND EXISTS (
       SELECT 1 FROM project
        WHERE id = p_project AND company_id = app.current_client_company()))
  INTO allowed;

  IF NOT allowed THEN
    -- Zeros, not an error: a refusal that looks different from an empty
    -- project is itself an answer about a project you may not see.
    done := 0; total := 0; percent := 0; by_hand := false; RETURN NEXT; RETURN;
  END IF;

  SELECT count(*) FILTER (WHERE t.status = 'completed')::int, count(*)::int
    INTO done, total
    FROM task t
   WHERE t.project_id = p_project;

  SELECT p.progress_override INTO v_manual FROM project p WHERE p.id = p_project;

  by_hand := v_manual IS NOT NULL;
  percent := CASE
               WHEN v_manual IS NOT NULL THEN v_manual::int
               WHEN total > 0 THEN round(100.0 * done / total)::int
               ELSE 0
             END;

  RETURN NEXT;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.project_progress(uuid) IS
  'Completed tasks, total, and the percentage a client is shown — which is the '
  'hand-set override when there is one and the task count otherwise. SECURITY '
  'DEFINER because the client role cannot read task at all, and guarded '
  'because a definer that takes an id is a way to ask about rows you were '
  'never shown.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.project_progress(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.project_progress(uuid) TO vixart_app, vixart_client;

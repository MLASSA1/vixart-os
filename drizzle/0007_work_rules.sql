-- =============================================================================
-- 0007 — Work module rules: task sign-off and row level security.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The two-step sign-off
--
-- A member moves their own task to `submitted` — "I am done". Only a moderator
-- or admin can move it to `completed`. This is a trigger, not a hidden button:
-- it holds even if the interface is bypassed entirely.
--
-- It also stamps the audit fields, so who signed off and when is never left to
-- application code.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.enforce_task_signoff() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Start-up tasks and the work moderators: unrestricted, but still stamped.
  IF app.is_bootstrap() OR app.is_moderator() THEN
    IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
      NEW.completed_at    := now();
      NEW.completed_by_id := COALESCE(NEW.completed_by_id, app.current_user_id());
    ELSIF NEW.status <> 'completed' THEN
      -- Re-opening a task clears the sign-off; it has to be earned again.
      NEW.completed_at    := NULL;
      NEW.completed_by_id := NULL;
    END IF;

    IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
      NEW.submitted_at := COALESCE(NEW.submitted_at, now());
    END IF;

    RETURN NEW;
  END IF;

  -- ---- from here: a plain member ----

  IF OLD.assignee_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'You can only update a task assigned to you.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = 'completed' THEN
    RAISE EXCEPTION
      'Only a moderator can mark a task completed. Submit it for review instead.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'This task was signed off by a moderator and cannot be reopened here.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A member moves the status. The definition of the work is not theirs to change.
  IF NEW.title       IS DISTINCT FROM OLD.title
  OR NEW.description IS DISTINCT FROM OLD.description
  OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
  OR NEW.priority    IS DISTINCT FROM OLD.priority
  OR NEW.due_date    IS DISTINCT FROM OLD.due_date
  OR NEW.project_id  IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'You can change the status of your task, not its definition.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    NEW.submitted_at := now();
  END IF;

  NEW.completed_at    := OLD.completed_at;
  NEW.completed_by_id := OLD.completed_by_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "task_signoff" BEFORE UPDATE ON "task"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_task_signoff();
--> statement-breakpoint

-- A new task always starts unsigned, whoever creates it.
CREATE OR REPLACE FUNCTION app.enforce_task_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (app.is_bootstrap() OR app.is_moderator()) THEN
    RAISE EXCEPTION 'Only a moderator can create and assign tasks.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.status          := COALESCE(NULLIF(NEW.status, 'completed'), 'todo');
  NEW.completed_at    := NULL;
  NEW.completed_by_id := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "task_insert_guard" BEFORE INSERT ON "task"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_task_insert();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Deals — money, so the team does not see them
--
-- A deal carries an estimated value. Members are kept away from prices and
-- totals, so the whole table is restricted to management and the work
-- moderator. Tighten this to admin only by dropping app.is_moderator() for
-- app.is_admin() in the two policies below.
-- -----------------------------------------------------------------------------

ALTER TABLE "deal" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "deal_select" ON "deal" FOR SELECT USING (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "deal_write" ON "deal" FOR ALL
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "deal_bootstrap" ON "deal" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Projects — the whole team sees the work; moderators shape it
-- -----------------------------------------------------------------------------

ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "project_select" ON "project"
  FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "project_insert" ON "project"
  FOR INSERT WITH CHECK (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "project_update" ON "project"
  FOR UPDATE USING (app.is_moderator()) WITH CHECK (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "project_delete" ON "project"
  FOR DELETE USING (app.is_admin());
--> statement-breakpoint
CREATE POLICY "project_bootstrap" ON "project" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Tasks
--
-- Everyone sees the board — one active client, full team immersion. What is
-- restricted is who may change what, and that is the trigger's job. The UPDATE
-- policy stays permissive for any signed-in user; the trigger then refuses a
-- member touching a task that is not theirs, or a field that is not the status.
-- -----------------------------------------------------------------------------

ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "task_select" ON "task" FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "task_insert" ON "task" FOR INSERT WITH CHECK (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "task_update" ON "task"
  FOR UPDATE USING (app.is_authenticated()) WITH CHECK (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "task_delete" ON "task" FOR DELETE USING (app.is_moderator());
--> statement-breakpoint
CREATE POLICY "task_bootstrap" ON "task" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

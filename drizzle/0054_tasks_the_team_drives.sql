-- =============================================================================
-- 0054 — 9A. A task stops being something only a manager can make.
--
-- Almost all of this already existed and had simply never been used: assignee,
-- due date, priority, the submit-then-sign-off flow, /my-work, and the 7B
-- notifications on assignment, overdue and awaiting sign-off. The system has
-- had zero tasks, which is why none of it has ever been seen working.
--
-- What actually changes here:
--
--   who may open one            moderator -> anybody real
--   what the assignee can say   todo/in_progress -> + accepted, + blocked
--   why it is stuck             a written reason, and the person who raised it
--                               is told
--   sub-tasks                   one level, enforced, never nested further
--
-- What deliberately does NOT change: sign-off. A completed task is still
-- signed off by a moderator or an admin and never by the person who did the
-- work. `app.enforce_task_signoff` already guarantees that and is left alone
-- except to take the two new columns into account.
-- =============================================================================

-- --- the assignee's vocabulary ----------------------------------------------
--
-- 'accepted' and 'blocked' join the existing four. 'done' from the brief is
-- 'submitted': the assignee says the work is finished, and it waits for a
-- sign-off. Adding a separate 'done' that meant the same thing would be a
-- second name for a state that already exists, and the first step towards
-- somebody signing off their own work.

ALTER TABLE task DROP CONSTRAINT task_status_valid;
--> statement-breakpoint

ALTER TABLE task ADD CONSTRAINT task_status_valid CHECK (status IN (
  'todo',        -- raised, nobody has said anything yet
  'accepted',    -- the assignee has seen it and taken it
  'in_progress',
  'blocked',     -- stuck on somebody else; carries a reason
  'submitted',   -- finished, waiting on a sign-off
  'completed'    -- signed off by a moderator or admin
));
--> statement-breakpoint

ALTER TABLE task ADD COLUMN blocked_reason text;
--> statement-breakpoint

COMMENT ON COLUMN task.blocked_reason IS
  'One line saying what it is stuck on. Required while blocked, cleared when it moves on.';
--> statement-breakpoint

-- A block without a reason is just a stalled task nobody can act on, which is
-- the thing this state exists to prevent.
ALTER TABLE task ADD CONSTRAINT task_blocked_needs_reason
  CHECK (status <> 'blocked' OR length(btrim(coalesce(blocked_reason, ''))) >= 3);
--> statement-breakpoint

-- --- sub-tasks, one level ----------------------------------------------------

ALTER TABLE task ADD COLUMN parent_id uuid REFERENCES task(id) ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE task ADD CONSTRAINT task_not_own_parent CHECK (parent_id IS DISTINCT FROM id);
--> statement-breakpoint

CREATE INDEX task_parent_idx ON task (parent_id) WHERE parent_id IS NOT NULL;
--> statement-breakpoint

/*
 * One level, enforced here rather than trusted to the interface.
 *
 * Two ways to get a third level and both are closed: giving a parent to a task
 * that already has one, and giving children to a task that is itself a child.
 * A CHECK cannot see other rows, so this is a trigger.
 */
CREATE FUNCTION app.enforce_task_depth() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM task p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'That is already a sub-task. Sub-tasks go one level deep — put this under its parent instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM task c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION
      'This task has sub-tasks of its own, so it cannot become one.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER task_depth
  BEFORE INSERT OR UPDATE OF parent_id ON task
  FOR EACH ROW EXECUTE FUNCTION app.enforce_task_depth();
--> statement-breakpoint

-- --- who may raise one -------------------------------------------------------
--
-- The editor who needs a photo raises it on the designer. That is the case this
-- phase exists for, and it was impossible: only a moderator could create a task
-- at all.
--
-- Still a real person: a service account has no work and cannot hand any out.

DROP POLICY task_insert ON task;
--> statement-breakpoint

CREATE POLICY task_insert ON task FOR INSERT WITH CHECK (app.is_real_person());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_task_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (app.is_bootstrap() OR app.is_real_person()) THEN
    RAISE EXCEPTION 'Only a member of the team can raise a task.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Who raised it is not the client's to choose. "Raised by me" on /my-work and
  -- the blocked notification both depend on this being true.
  IF NOT app.is_bootstrap() THEN
    NEW.created_by_id := app.current_user_id();
  END IF;

  -- Whoever opens it, a task starts unstarted and unsigned.
  NEW.status          := COALESCE(NULLIF(NEW.status, 'completed'), 'todo');
  NEW.completed_at    := NULL;
  NEW.completed_by_id := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- --- the assignee answers for it --------------------------------------------
--
-- Unchanged: a member may only touch a task assigned to them, may not mark it
-- completed, may not reopen one that was signed off, and may not edit its
-- definition. Two additions only —
--
--   `parent_id` joins the list a member may not change. Moving a task under a
--   different parent is a change to what the work IS, not to how it is going,
--   and it was missing from that list the moment the column existed.
--
--   `blocked_reason` is theirs to write, and is cleared the moment the task
--   stops being blocked so a stale excuse cannot outlive the block.

CREATE OR REPLACE FUNCTION app.enforce_task_signoff() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() OR app.is_moderator() THEN
    IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
      NEW.completed_at    := now();
      NEW.completed_by_id := COALESCE(NEW.completed_by_id, app.current_user_id());
    ELSIF NEW.status <> 'completed' THEN
      NEW.completed_at    := NULL;
      NEW.completed_by_id := NULL;
    END IF;

    IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
      NEW.submitted_at := COALESCE(NEW.submitted_at, now());
    END IF;

    IF NEW.status <> 'blocked' THEN
      NEW.blocked_reason := NULL;
    END IF;

    RETURN NEW;
  END IF;

  -- ---- a plain member ----

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

  IF NEW.title       IS DISTINCT FROM OLD.title
  OR NEW.description IS DISTINCT FROM OLD.description
  OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
  OR NEW.priority    IS DISTINCT FROM OLD.priority
  OR NEW.due_date    IS DISTINCT FROM OLD.due_date
  OR NEW.project_id  IS DISTINCT FROM OLD.project_id
  OR NEW.parent_id   IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'You can change the status of your task, not its definition.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    NEW.submitted_at := now();
  END IF;

  IF NEW.status <> 'blocked' THEN
    NEW.blocked_reason := NULL;
  END IF;

  NEW.completed_at    := OLD.completed_at;
  NEW.completed_by_id := OLD.completed_by_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- --- blocked tells the person who raised it ---------------------------------
--
-- This is the whole point of the state. A task nobody can move forward is only
-- useful if the person waiting on it finds out; otherwise "blocked" is a quiet
-- place for work to go and die.

ALTER TABLE notification DROP CONSTRAINT notification_kind_valid;
--> statement-breakpoint

ALTER TABLE notification ADD CONSTRAINT notification_kind_valid CHECK (kind IN (
  'task_assigned',
  'mentioned',
  'task_overdue',
  'task_awaiting_signoff',
  'task_blocked'
));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.notify_on_task_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_project text;
  v_who     text;
BEGIN
  IF NOT app.is_authenticated() AND NOT app.is_bootstrap() THEN
    RETURN NEW;   -- nothing to attribute it to
  END IF;

  SELECT name INTO v_project FROM project WHERE id = NEW.project_id;

  -- Assigned, or reassigned to somebody new.
  IF NEW.assignee_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) THEN
    PERFORM app.notify(
      NEW.assignee_id, 'task_assigned',
      NEW.title,
      '/my-work',
      coalesce(v_project, 'A project'),
      'task', NEW.id);
  END IF;

  -- Submitted for review: everyone who can sign it off should know.
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    PERFORM app.notify(
      u.id, 'task_awaiting_signoff',
      NEW.title,
      '/projects/' || NEW.project_id::text,
      'Submitted and waiting on a sign-off',
      'task', NEW.id)
      FROM app_user u
     WHERE u.role IN ('admin','moderator')
       AND u.is_active AND u.is_assignable AND NOT u.is_service_account;
  END IF;

  -- Blocked: the person who raised it is the one who can unblock it.
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'blocked' AND OLD.status IS DISTINCT FROM 'blocked'
     AND NEW.created_by_id IS NOT NULL
     -- Blocking your own task tells you nothing you did not just type.
     AND NEW.created_by_id IS DISTINCT FROM app.current_user_id() THEN
    SELECT full_name INTO v_who FROM app_user WHERE id = NEW.assignee_id;
    PERFORM app.notify(
      NEW.created_by_id, 'task_blocked',
      NEW.title,
      '/my-work',
      coalesce(v_who, 'The assignee') || ' is blocked: ' || coalesce(NEW.blocked_reason, ''),
      'task', NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

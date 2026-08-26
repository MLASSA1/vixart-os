-- =============================================================================
-- 0029 — Teach the task triggers about the work agent.
--
-- 0028 gave the agent a column grant and an RLS policy, and it still could not
-- assign a task: `app.enforce_task_signoff` was written when the only actors
-- were people. It has two paths — moderator (unrestricted) and member
-- (own task, status only) — and the agent fell into the member path, where it
-- was refused for not being the assignee.
--
-- The fix is a third path, and it is the exact INVERSE of a member's:
--
--   a member  may change status, and nothing else
--   the agent may change everything except status
--
-- Between them they cover the table, and neither can do the other's job. A
-- member cannot reassign their work to someone else; the agent cannot declare
-- work finished. Completion stays a human act.
--
-- `enforce_task_insert` gets the same treatment: the agent may open a task,
-- which is the point of a distribution agent, but only ever an unstarted one.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.enforce_task_signoff() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Start-up tasks and the work moderators: unrestricted, but still stamped.
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

    RETURN NEW;
  END IF;

  -- ---- the work agent: moves work, never finishes it ----
  --
  -- The column grant already refuses an UPDATE naming `status`, so this branch
  -- is the second of two independent refusals. It is here because a grant is
  -- invisible to someone reading the trigger, and this is the rule that
  -- matters most.
  IF app.is_work_agent() THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'The work agent cannot change a task''s status. Submitting and signing '
        'off are done by people.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.title       IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.project_id  IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION
        'The work agent can reassign and reschedule a task, not rewrite what it is.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Sign-off state is never touched by a reassignment.
    NEW.completed_at    := OLD.completed_at;
    NEW.completed_by_id := OLD.completed_by_id;
    NEW.submitted_at    := OLD.submitted_at;
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

CREATE OR REPLACE FUNCTION app.enforce_task_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (app.is_bootstrap() OR app.is_moderator() OR app.is_work_agent()) THEN
    RAISE EXCEPTION 'Only a moderator can create and assign tasks.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Whoever opens it, a task starts unstarted and unsigned.
  NEW.status          := COALESCE(NULLIF(NEW.status, 'completed'), 'todo');
  NEW.completed_at    := NULL;
  NEW.completed_by_id := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 0028's app.enforce_work_agent_limits() said the same thing as the work-agent
-- branch above, on its own trigger. Two triggers enforcing one rule is how they
-- drift apart. The rule now lives in one place; this one becomes a no-op that
-- is dropped rather than left to rot.
DROP TRIGGER IF EXISTS "task_work_agent_limits" ON "task";
--> statement-breakpoint
DROP FUNCTION IF EXISTS app.enforce_work_agent_limits();

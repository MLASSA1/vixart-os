-- =============================================================================
-- 0075 — A member sees their own work, and signs it off themselves.
--
-- Three changes Amin asked for in one message, and they belong together because
-- they are one decision about how the team works: everybody minds their own
-- tasks, moves them with three buttons, and management is TOLD when something is
-- finished rather than asked for permission.
--
-- 1. WHO CAN SEE A TASK.
--
-- `task_select` was `app.is_authenticated()`, so all eight people saw all
-- hundred and forty-one tasks. That was right when the task list was the shared
-- board; it is not what Amin wants now — "each assigned task need to be shown to
-- only the assigned member only, not all team can see each ones tasks".
--
-- A member now sees a task if it is theirs OR they raised it. The second half
-- matters: a member who asks a colleague for something has a stake in it, the
-- blocked notification already goes to whoever raised a task, and losing sight
-- of what you asked for is not privacy, it is amnesia.
--
-- NOT TOUCHED, deliberately: `app.project_progress()` is SECURITY DEFINER and
-- counts tasks inside the database, so a client's progress bar and the figures
-- on a client's page are unaffected by who is looking. If that function had read
-- `task` through the caller's policies instead, this change would have silently
-- dropped every client's progress to zero for six of the eight people here.
--
-- 2. THE ASSIGNEE SIGNS OFF THEIR OWN WORK.
--
-- `enforce_task_signoff` refused `completed` from a member and told them to
-- submit it for review. Amin's three buttons are accepted, in progress and
-- completed — there is no submit step any more, so the rule that pointed at one
-- has to go.
--
-- What replaces the gate is a notification, which is the trade he chose: trust
-- the person who did the work, and tell the people who need to know. The stamp
-- still says who finished it and when, so the record is no weaker — it is the
-- permission that moved, not the accountability.
--
-- A member may also REOPEN their own completed task. With three buttons a
-- mis-click is otherwise permanent until a moderator intervenes, and the stamp
-- is cleared when they do, exactly as it is for a moderator.
--
-- `submitted` and `blocked` stay VALID STATUSES. Two tasks are submitted in
-- production right now, and a status that nothing can leave is a row nobody can
-- fix. The three buttons reach any state from any state, so those two are
-- movable; what is gone is the way to enter them.
--
-- 3. SOMEBODY FINISHED SOMETHING.
--
-- A new notification, to whoever raised the task and to management — "me and
-- mohamed amin will be notified or the person who assigned that task", so both.
-- Deduplicated by a UNION, and `app.notify` already refuses to tell somebody
-- about their own action, so finishing your own task does not notify you.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Who can see a task
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS task_select ON task;
--> statement-breakpoint

CREATE POLICY task_select ON task FOR SELECT
  USING (
    -- Management sees the board, because somebody has to.
    app.is_moderator()
    -- Yours to do.
    OR assignee_id = app.current_user_id()
    -- Or yours to have asked for. Losing sight of what you raised is not
    -- privacy, and the blocked notification already goes to this person.
    OR created_by_id = app.current_user_id()
  );
--> statement-breakpoint

COMMENT ON TABLE task IS
  'A piece of work. Visible to the person it is assigned to, the person who '
  'raised it, and management (0075) — not to the whole team as it was.';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. The assignee signs off their own work
-- -----------------------------------------------------------------------------

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

  /*
   * The definition of the work is still not theirs to change.
   *
   * This is the half of the old rule that was never about sign-off: moving your
   * own task along is yours, rewriting what the task IS belongs to whoever
   * asked for it. Unchanged.
   */
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

  /*
   * THE TWO REFUSALS THAT ARE GONE, and what took their place.
   *
   * It used to raise on `completed` ("Only a moderator can mark a task
   * completed. Submit it for review instead.") and on reopening one. Both
   * pointed at a submit-for-review step that no longer exists: Amin's three
   * buttons are accepted, in progress, completed.
   *
   * What replaced the permission is a notification — `task_completed`, to
   * whoever raised it and to management. The stamp below still records who
   * finished it and when, so what moved is who may press the button, not who is
   * answerable for it.
   */
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    NEW.completed_at    := now();
    -- Their own name, never one passed in: a member cannot sign off as somebody
    -- else by sending a different id.
    NEW.completed_by_id := app.current_user_id();
  ELSIF NEW.status <> 'completed' THEN
    -- Reopening clears the sign-off, exactly as it does for a moderator. With
    -- three buttons this is the only way to undo a mis-click.
    NEW.completed_at    := NULL;
    NEW.completed_by_id := NULL;
  ELSE
    -- Still completed and staying completed: the original stamp stands and
    -- cannot be rewritten.
    NEW.completed_at    := OLD.completed_at;
    NEW.completed_by_id := OLD.completed_by_id;
  END IF;

  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    NEW.submitted_at := now();
  END IF;

  IF NEW.status <> 'blocked' THEN
    NEW.blocked_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.enforce_task_signoff() IS
  'What a member may do to their own task: move its status, including to '
  'completed (0075), and not rewrite what the task is. Completion stamps their '
  'own id and notifies whoever raised it plus management.';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Somebody finished something
-- -----------------------------------------------------------------------------

ALTER TABLE notification DROP CONSTRAINT notification_kind_valid;
--> statement-breakpoint

ALTER TABLE notification ADD CONSTRAINT notification_kind_valid CHECK (kind IN (
  'task_assigned',
  'mentioned',
  'task_overdue',
  'task_awaiting_signoff',
  'task_blocked',
  'task_completed',         -- somebody finished a task you raised or manage
  'message_received',
  'client_message'
));
--> statement-breakpoint

/*
 * One per task per person, ever.
 *
 * `task_completed` joins the kinds that describe a STATE rather than an event.
 * A task completed, reopened and completed again is not two pieces of news, and
 * without this a member correcting a mis-click twice would send Amin three
 * emails about one task.
 */
DROP INDEX IF EXISTS notification_one_per_state;
--> statement-breakpoint
CREATE UNIQUE INDEX notification_one_per_state
  ON notification (recipient_id, kind, entity_id)
  WHERE kind IN ('task_overdue', 'task_awaiting_signoff', 'task_completed')
    AND entity_id IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.notify_on_task_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project text;
  v_who     text;
  v_link    text;
BEGIN
  IF NOT app.is_authenticated() AND NOT app.is_bootstrap() THEN
    RETURN NEW;   -- nothing to attribute it to
  END IF;

  SELECT name INTO v_project FROM project WHERE id = NEW.project_id;

  v_link := CASE
              WHEN NEW.project_id IS NULL THEN '/tasks'
              ELSE '/projects/' || NEW.project_id::text
            END;

  -- Assigned, or reassigned to somebody new.
  IF NEW.assignee_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) THEN
    PERFORM app.notify(
      NEW.assignee_id, 'task_assigned',
      NEW.title,
      '/my-work',
      coalesce(v_project, 'Internal work'),
      'task', NEW.id);
  END IF;

  /*
   * FINISHED. The notification that replaced the sign-off gate.
   *
   * To whoever raised it and to management both — Amin asked for "me and mohamed
   * amin ... or the person who assigned that task", and those are usually the
   * same person, so a UNION says both without saying it twice.
   *
   * `completed_by_id` is read rather than assumed: `task_signoff` is a BEFORE
   * trigger and has already stamped it, and it is the member's own id because
   * that function will not accept another.
   *
   * `app.notify` refuses to tell anybody about their own action, so finishing
   * your own task notifies the others and not you.
   */
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT full_name INTO v_who FROM app_user WHERE id = NEW.completed_by_id;

    PERFORM app.notify(
      r.id, 'task_completed',
      NEW.title,
      v_link,
      coalesce(v_who, 'Someone') || ' finished it'
        || coalesce(' — ' || v_project, ''),
      'task', NEW.id)
      FROM (
        SELECT u.id
          FROM app_user u
         WHERE u.role IN ('admin', 'moderator')
           AND u.is_active AND u.is_assignable AND NOT u.is_service_account
        UNION
        SELECT NEW.created_by_id
         WHERE NEW.created_by_id IS NOT NULL
      ) AS r;
  END IF;

  -- Submitted for review: nothing enters this state any more, and the branch
  -- stays for the two rows that are already in it.
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    PERFORM app.notify(
      u.id, 'task_awaiting_signoff',
      NEW.title,
      v_link,
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
--> statement-breakpoint

COMMENT ON FUNCTION app.notify_on_task_change() IS
  'Assignment, completion, submission and blocking, as inbox rows. Completion '
  'goes to whoever raised the task and to management (0075) — the notification '
  'that replaced the sign-off gate.';

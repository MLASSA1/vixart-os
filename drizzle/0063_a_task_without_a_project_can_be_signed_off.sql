-- =============================================================================
-- 0063 — A task without a project can be submitted for sign-off.
--
-- 0055 let a task exist without a project, because internal work is real work
-- and does not belong to a client. It did not revisit the notification trigger
-- written in 0054, back when every task had one.
--
-- So this, on submitting an internal task for sign-off:
--
--     '/projects/' || NEW.project_id::text
--
-- With no project that concatenation is NULL, `notification.link` is NOT NULL,
-- and the INSERT raises. The raise is inside a BEFORE trigger, so it takes the
-- whole UPDATE with it: the task does not move to `submitted` at all. Every
-- internal task in the system could be raised, assigned, accepted and worked
-- on — and then refused at the one step that finishes it, with a constraint
-- error from a table the person has never heard of.
--
-- Found by submitting one. It is not reachable from the tests that exist
-- because they all made a project first, which is exactly the habit that hid
-- it: the feature is the absence of the thing every test provides.
--
-- The second fix is smaller and in the same place. An assignment notification
-- said `coalesce(v_project, 'A project')` — so internal work announced itself
-- as "A project", which is both wrong and the precise distinction 0055 exists
-- to draw.
-- =============================================================================

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

  -- Where the notification points. Internal work lives on /tasks; a client
  -- project's work is read in the context of that project.
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

  -- Submitted for review: everyone who can sign it off should know.
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

COMMENT ON FUNCTION app.notify_on_task_change() IS
  'Task notifications. Every link it builds must survive a NULL project_id: '
  'internal work has none, and a NULL link fails a NOT NULL and takes the '
  'whole status change with it.';

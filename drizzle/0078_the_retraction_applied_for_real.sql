/*
 * The retraction from 0077, applied for real this time.
 *
 * WHY THIS MIGRATION EXISTS AT ALL, GIVEN 0077 ALREADY CONTAINS IT.
 *
 * Because I added it to 0077 AFTER 0077 had been applied, and an applied
 * migration never runs again. Drizzle journals a migration once and then
 * reports "already up to date" — so `app.notify_retract` and the reopen branch
 * sat in the file, passed review, passed the type check, and existed in no
 * database. The definer-guard test agreed there was nothing wrong, because the
 * function it would have checked was not there to check.
 *
 * Production had never applied 0077, so it would have received the full file
 * and been correct — which is the worst version of this: the environment I
 * verify against was the only one that was wrong, and it was the one telling me
 * the work was done.
 *
 * So the fix goes in its own migration rather than by editing 0077 again. Both
 * statements below are CREATE OR REPLACE, so an environment that already has
 * 0077's copy applies them harmlessly a second time, and the one that missed
 * them gets them. Nothing here is new behaviour — it is 0077's own text, in a
 * file that will actually run.
 *
 * The rule this is a monument to: once a migration has been applied anywhere,
 * it is immutable. Change it in a new one.
 */

CREATE OR REPLACE FUNCTION app.notify_retract(
  p_kind text, p_entity_type text, p_entity_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_gone integer;
BEGIN
  IF NOT app.is_authenticated() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only a signed-in person can retract a notification.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_entity_id IS NULL THEN RETURN 0; END IF;

  DELETE FROM notification
   WHERE kind = p_kind
     AND entity_type = p_entity_type
     AND entity_id = p_entity_id;

  GET DIAGNOSTICS v_gone = ROW_COUNT;
  RETURN v_gone;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.notify_retract(text, text, uuid) IS
  'Removes a state notification that has stopped being true, so '
  'notification_one_per_state does not keep the stale one for ever (0077).';
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

  -- For the branches whose recipients may all see a project.
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
   * REOPENED. The completion notice is withdrawn before anything else, so that
   * a task which goes completed -> in progress -> completed produces a fresh
   * notice naming whoever actually finished it the second time.
   */
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'completed' AND NEW.status IS DISTINCT FROM 'completed' THEN
    PERFORM app.notify_retract('task_completed', 'task', NEW.id);
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
      CASE
        WHEN NEW.project_id IS NOT NULL AND r.role IN ('admin', 'moderator')
          THEN '/projects/' || NEW.project_id::text
        ELSE '/tasks'
      END,
      coalesce(v_who, 'Someone') || ' finished it'
        || coalesce(' — ' || v_project, ''),
      'task', NEW.id)
      FROM (
        SELECT u.id, u.role
          FROM app_user u
         WHERE u.role IN ('admin', 'moderator')
           AND u.is_active AND u.is_assignable AND NOT u.is_service_account
        UNION
        SELECT c.id, c.role
          FROM app_user c
         WHERE c.id = NEW.created_by_id
      ) AS r;
  END IF;

  -- Submitted for review: nothing enters this state any more, and the branch
  -- stays for the two rows that are already in it. Management only, so v_link.
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
  'goes to whoever raised the task and to management (0075), each linked to a '
  'page they can actually open (0077).';

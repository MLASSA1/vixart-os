/*
 * Two things the audit of 0075/0076 turned up, both of them mine.
 *
 * 1. `app.task_sort_key` read a title that is ONLY a number as having no
 *    number at all, so "1, 2, 3, 10, 16" sorted "1, 10, 16, 2, 3" — the exact
 *    complaint 0076 was written to fix, surviving in the one title shape most
 *    likely to be typed.
 *
 * 2. The `task_completed` notification sent every recipient to the project
 *    page, including the member who raised the task, and a member is bounced
 *    off /projects. The inbox row was a dead end for the person it was for.
 *
 * Production data is untouched by both: no title is currently all digits, and
 * notification rows already written keep their links.
 */

/*
 * THE SORT KEY, AND WHY THE OLD ONE MISSED.
 *
 * It extracted the number with
 *
 *     nullif(regexp_replace(title, '^[^0-9]*([0-9]{1,9}).*$', '\1'), title)
 *
 * The nullif was meant to say "the pattern did not match", because a
 * regexp_replace that matches nothing returns its input unchanged. But when the
 * title IS the number, the replacement is ALSO the input — "16" in, "16" out —
 * and nullif could not tell a successful extraction from a failed one. Those
 * titles got the no-number key, 0, and fell back to sorting as text.
 *
 * `substring(... from ...)` has no such ambiguity: it returns the match, or
 * NULL when there is none, and never the input. That is the whole fix.
 *
 * Unchanged: the prefix before the first digit keeps separate series apart
 * ("TASK 2" sorts within TASK, not among "Task"), the number is padded to nine
 * so text order is numeric order, and the title follows as a tie-break.
 */
CREATE OR REPLACE FUNCTION app.task_sort_key(p_title text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT
    regexp_replace(p_title, '[0-9].*$', '')
    || lpad(coalesce(substring(p_title from '[0-9]{1,9}'), '0'), 9, '0')
    || p_title
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.task_sort_key(text) IS
  'Natural sort key for a task title: the text before the first number, then '
  'that number padded to nine digits, then the title. A title that is only a '
  'number is numbered too (0077) — 0076 read it as unnumbered.';
--> statement-breakpoint

/*
 * TAKING A NOTIFICATION BACK, because `notification_one_per_state` means the
 * first one is the only one there will ever be.
 *
 * 0075 added `task_completed` to that index — one row per person per task, for
 * good reasons: a member correcting a mis-click twice must not send Amin three
 * emails about one task. But `app.notify` inserts `ON CONFLICT DO NOTHING`, so
 * the FIRST completion is the one that survives for ever. Reopen a task,
 * somebody else finishes it, and the index swallows the new notice — leaving a
 * row in the inbox that names the wrong person and the wrong day, which is
 * worse than no row, because it is specific.
 *
 * So reopening retracts. The news "X finished it" stops being true the moment
 * the task leaves `completed`, and a notification that is no longer true is not
 * history worth keeping — nothing else references it, and the activity log,
 * which IS the history, is untouched and append-only as always.
 *
 * A DEFINER for the same reason `app.notify` is one: `notification` accepts no
 * DELETE from anybody, by design. It is guarded like `app.notify` too, and it
 * names no recipient — it can only retract a given kind for a given row, never
 * reach into one person's inbox.
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

/*
 * THE COMPLETION NOTIFICATION, LINKED WHERE THE READER CAN GO.
 *
 * Only this branch changes. `task_assigned` and `task_blocked` already point at
 * /my-work, and `task_awaiting_signoff` goes to management alone, so a project
 * link is right for it.
 *
 * The recipients are management UNION whoever raised the task, and that second
 * one can be a member — members raise tasks, and may attach them to a project,
 * which is how a member came to be handed /projects/<id>. The link is now
 * decided per recipient rather than once for all of them, so management still
 * lands on the project and the member lands on the task list, where the task is
 * visible to them because they raised it.
 */
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

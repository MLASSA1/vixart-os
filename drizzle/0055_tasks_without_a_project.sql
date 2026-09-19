-- =============================================================================
-- 0055 — A task does not have to belong to a project.
--
-- Until now `task.project_id` was NOT NULL, so every piece of work had to be
-- filed under a client engagement before it could exist. That is wrong for a
-- large part of what the team actually does: fix the studio lighting, renew the
-- domain, prepare the reel, call the accountant. None of it is a client
-- project, and forcing it into one either invents a fake project or means the
-- work is never written down at all.
--
-- So the column becomes optional. Nothing else about a task changes: the same
-- statuses, the same sign-off, the same notifications, the same sub-tasks.
--
-- Everything that reads a task's project must now expect nothing to be there.
-- The three page queries move to LEFT JOIN in the same commit; the functions
-- below were already null-tolerant and are left alone —
--
--   notify_on_task_change   SELECT ... INTO v_project leaves it null and the
--                           coalesce already handles it
--   notify_overdue_tasks    carries project_id through without dereferencing it
--   enforce_task_signoff    compares it, never follows it
-- =============================================================================

ALTER TABLE task ALTER COLUMN project_id DROP NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN task.project_id IS
  'The client engagement this belongs to, when it belongs to one. Null for internal work that is not a project.';
--> statement-breakpoint

-- A sub-task belongs where its parent belongs. Allowing a child under a
-- project while its parent is internal would put one piece of work in two
-- places, and every list that groups by project would disagree with itself.
CREATE FUNCTION app.enforce_subtask_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent_project uuid;
  v_found boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT project_id, true INTO v_parent_project, v_found
    FROM task WHERE id = NEW.parent_id;

  IF v_found AND NEW.project_id IS DISTINCT FROM v_parent_project THEN
    RAISE EXCEPTION
      'A sub-task belongs to the same project as its parent.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER task_subtask_project
  BEFORE INSERT OR UPDATE OF parent_id, project_id ON task
  FOR EACH ROW EXECUTE FUNCTION app.enforce_subtask_project();
--> statement-breakpoint

-- Internal work is found by its absence of a project, and that is a common
-- enough question to index.
CREATE INDEX task_internal_idx ON task (assignee_id, status) WHERE project_id IS NULL;

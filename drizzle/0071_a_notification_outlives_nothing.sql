-- =============================================================================
-- 0071 — A notification does not outlive the thing it points at.
--
-- Found while adding message notifications: the test database had accumulated
-- two dozen notification rows whose `entity_id` named a thread that no longer
-- existed. Harmless there. Not harmless here.
--
-- `notification.entity_id` is polymorphic — a task, a thread, whatever raised it
-- — so there is no foreign key to cascade, which is why nothing cleaned up. What
-- that produces in the application is an inbox row you cannot act on: the link
-- is `/chat/<a thread that is gone>`, and clicking it gets a 404 on a page that
-- was addressed to you personally. The reader cannot tell that from the system
-- being broken, and cannot make it go away except by marking it read.
--
-- A trigger per parent table, then. Narrow on purpose: it deletes only rows
-- whose entity_type matches, so a task and a thread that happen to share a uuid
-- — which cannot happen, but the rule should not depend on that — do not touch
-- each other's notifications.
--
-- Not the activity log. `activity` is append-only and stays whole: what
-- happened, happened. This is an unread pointer, which is a different kind of
-- thing entirely.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.forget_notifications_for()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER because `notification` accepts no DELETE from anybody: the table is
-- written through functions by design. No arguments, no reach beyond the row
-- that was just deleted.
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM notification
   WHERE entity_type = TG_ARGV[0]
     AND entity_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.forget_notifications_for() IS
  'Removes notifications pointing at a row that has been deleted. Takes the '
  'entity_type as a trigger argument. EXEMPT from the definer-caller check: no '
  'arguments from a caller, no data returned, and it can only ever affect rows '
  'that name the row being deleted.';
--> statement-breakpoint

DROP TRIGGER IF EXISTS thread_forgets_notifications ON thread;
--> statement-breakpoint
CREATE TRIGGER thread_forgets_notifications
  AFTER DELETE ON thread
  FOR EACH ROW EXECUTE FUNCTION app.forget_notifications_for('thread');
--> statement-breakpoint

DROP TRIGGER IF EXISTS task_forgets_notifications ON task;
--> statement-breakpoint
CREATE TRIGGER task_forgets_notifications
  AFTER DELETE ON task
  FOR EACH ROW EXECUTE FUNCTION app.forget_notifications_for('task');
--> statement-breakpoint

-- The ones already orphaned. Not "all notifications with a missing parent" —
-- only the two entity types the triggers above now keep, so a kind added later
-- with its own lifecycle is not silently swept up by a migration.
DELETE FROM notification n
 WHERE n.entity_type = 'thread'
   AND NOT EXISTS (SELECT 1 FROM thread t WHERE t.id = n.entity_id);
--> statement-breakpoint

DELETE FROM notification n
 WHERE n.entity_type = 'task'
   AND NOT EXISTS (SELECT 1 FROM task t WHERE t.id = n.entity_id);

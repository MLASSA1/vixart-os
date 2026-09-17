-- =============================================================================
-- 0047 — Opening a channel by hand is a moderator's job.
--
-- 0042 let any real person start a thread, which was right when a thread was
-- something you made because you needed one. Now that every project and every
-- client already has a channel, a hand-made one is an addition to a list that
-- has to stay readable, and that is a decision for whoever runs the work.
--
-- The awkward part: the automatic channels are inserted by triggers running as
-- whoever created the parent record — and `company_insert` allows ANY
-- authenticated person, so a member adding a client would have their company
-- insert fail on a policy about chat. Row level security cannot tell a
-- trigger's INSERT from a typed one, and the two ways to make it tell are both
-- worse than the problem: a SECURITY DEFINER trigger throws away the property
-- that these run under the creator's own policies (the exact mistake 0044 had
-- to undo), and a transaction-local flag is a password the client can read.
--
-- So the rule is stated in terms of the row instead: a moderator may open any
-- channel; anyone else may only cause one that is `is_default` and points at a
-- parent that qualifies for one. The residue is that a member could, in raw
-- SQL, hand-craft a default channel for a client that somehow has none — a
-- state the triggers and the unique indexes make unreachable, producing a row
-- identical to the one the trigger would have produced. That is not worth a
-- mechanism.
-- =============================================================================

DROP POLICY thread_insert ON thread;
--> statement-breakpoint

CREATE POLICY thread_insert ON thread
  FOR INSERT
  WITH CHECK (
    app.is_real_person()
    AND created_by_id = app.current_user_id()
    AND (
      app.is_moderator()
      OR (
        is_default
        AND (
             (kind = 'project'
              AND EXISTS (SELECT 1 FROM project p WHERE p.id = thread.project_id))
          OR (kind = 'company'
              AND EXISTS (SELECT 1 FROM company c
                           WHERE c.id = thread.company_id AND c.status = 'client'))
        )
      )
    )
  );
--> statement-breakpoint

-- Renaming and retitling stay open to everyone who can see the channel, as
-- they were. Nothing about this migration changes who can READ one: that is
-- `thread_select`, and it still asks the parent record.
COMMENT ON POLICY thread_insert ON thread IS
  'A moderator opens a channel deliberately. Anyone else only causes the automatic one that comes with a project or a client.';

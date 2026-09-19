-- =============================================================================
-- 0056 — Taking a message back, visibly.
--
-- Chat shipped with no DELETE policy at all, deliberately: a conversation is a
-- record, not a whiteboard. That is still true, and this does not change it.
-- What it adds is the thing people actually need — a way to take back a
-- message sent to the wrong channel, or one they regret — without the
-- conversation silently rearranging itself afterwards.
--
-- So a withdrawal leaves a mark. The row stays, keeping its place in the
-- conversation and its timestamps, and records who removed it and when. What
-- goes is the text: "deleted" that leaves the words sitting in the database for
-- anyone with SQL access is not deletion, it is hiding.
--
-- There is still no DELETE policy. A message cannot be made to have never
-- existed — only to have been withdrawn, by a named person, at a stated time.
--
-- Who: the author, at any time, and an administrator. Not the fifteen-minute
-- edit window — that exists so a correction cannot quietly rewrite what was
-- said an hour ago, which is the opposite concern to this one.
-- =============================================================================

ALTER TABLE message ADD COLUMN withdrawn_at timestamptz;
--> statement-breakpoint

ALTER TABLE message ADD COLUMN withdrawn_by_id uuid REFERENCES app_user(id) ON DELETE SET NULL;
--> statement-breakpoint

COMMENT ON COLUMN message.withdrawn_at IS
  'When the message was taken back. The row stays; the text does not.';
--> statement-breakpoint

-- Both or neither. A withdrawal with nobody attached to it is exactly the
-- silent rewrite this design is avoiding.
ALTER TABLE message ADD CONSTRAINT message_withdrawal_attributed
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by_id IS NULL));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_message_edit_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() THEN
    RETURN NEW;
  END IF;

  -- Nothing about a withdrawn message can change again. It is finished.
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'That message was withdrawn and cannot be changed.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.thread_id   IS DISTINCT FROM OLD.thread_id
  OR NEW.author_id   IS DISTINCT FROM OLD.author_id
  OR NEW.author_name IS DISTINCT FROM OLD.author_name
  OR NEW.created_at  IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Only the text of a message can be corrected.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ---- a withdrawal ----
  IF NEW.withdrawn_at IS NOT NULL THEN
    IF OLD.author_id IS DISTINCT FROM app.current_user_id() AND NOT app.is_admin() THEN
      RAISE EXCEPTION 'Only the person who wrote a message, or an administrator, can take it back.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Set here, not trusted from the client: who withdrew it is the whole
    -- point of leaving a mark.
    NEW.withdrawn_at    := now();
    NEW.withdrawn_by_id := app.current_user_id();
    -- The text goes. Kept in the row it would still be readable to anyone with
    -- database access, which is not what "deleted" means to the person asking.
    NEW.body            := '';
    NEW.edited_at       := OLD.edited_at;
    RETURN NEW;
  END IF;

  -- ---- an ordinary correction ----
  IF OLD.created_at < now() - interval '15 minutes' THEN
    RAISE EXCEPTION
      'A message can be corrected for fifteen minutes after sending. After that it stands.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.edited_at := now();
  RETURN NEW;
END;
$$;

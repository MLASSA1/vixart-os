-- =============================================================================
-- 0057 — Two corrections to 0056, both found by its own tests.
--
-- 1. `message_body_present` required every message to have text, and a
--    withdrawal blanks it. The invariant was never "every row has text" — it
--    is "a message somebody can read has text". Withdrawn rows are exempt.
--
-- 2. 0056's trigger allowed an administrator to withdraw anybody's message.
--    That branch can never run: `message_update` is USING (author_id =
--    app.current_user_id()), so a non-author's UPDATE matches no rows at all
--    and succeeds having done nothing. RLS refuses it before the trigger is
--    reached — which is the stronger guarantee, and the branch was a comment
--    claiming a capability the system does not have.
--
--    Withdrawal is the author's, and only the author's. Nobody asked for
--    administrators to be able to edit other people's conversations, and
--    quietly leaving a door that does not open is worse than not having one.
-- =============================================================================

ALTER TABLE message DROP CONSTRAINT message_body_present;
--> statement-breakpoint

ALTER TABLE message ADD CONSTRAINT message_body_present
  CHECK (withdrawn_at IS NOT NULL OR length(trim(body)) > 0);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_message_edit_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() THEN
    RETURN NEW;
  END IF;

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
  --
  -- Reaching here at all means RLS has allowed the update, which it does only for
  -- the author. No second check is written: two copies of one rule drift.
  IF NEW.withdrawn_at IS NOT NULL THEN
    NEW.withdrawn_at    := now();
    NEW.withdrawn_by_id := app.current_user_id();
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

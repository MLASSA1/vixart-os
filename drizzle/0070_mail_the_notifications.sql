-- =============================================================================
-- 0070 — A notification that also arrives in your mailbox.
--
-- Amin asked for two emails: one to whoever a task is assigned to, and one for a
-- private message. And private messages had no notification of ANY kind — the
-- inbox knew about tasks and mentions, and a colleague writing to you directly
-- produced nothing but a bold line in a channel list you might not have open.
--
-- THE SHAPE, AND WHY IT IS AN OUTBOX RATHER THAN A SEND.
--
-- Notifications are created by database triggers, deliberately: a task can be
-- assigned from the project screen, from a task row, or by a moderator editing
-- it, and a notification that depends on somebody remembering to call it is one
-- that will be missed from the fourth place. But a trigger cannot send an
-- email — it has no network, and an email attempted inside a transaction would
-- either hold the write open on somebody's slow mail server or be lost when the
-- transaction rolled back.
--
-- So the row IS the outbox. Three columns record what has happened to it, a
-- sweep in the application claims and sends, and the worst case is a late
-- email rather than a lost one or a blocked write.
--
-- ONE ROW PER CONVERSATION, NOT PER MESSAGE.
--
-- Twenty messages from one person must not be twenty inbox rows. An unread
-- `message_received` for a thread is BUMPED instead — new time, new body — and
-- bumping clears the mail state, so the conversation becomes eligible to email
-- again. The sweep then enforces a gap, which means a rapid exchange sends one
-- email rather than twenty and the sender of the twentieth message is not the
-- reason somebody's mailbox is unusable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The two events that had no notification at all
-- -----------------------------------------------------------------------------

ALTER TABLE notification DROP CONSTRAINT notification_kind_valid;
--> statement-breakpoint

ALTER TABLE notification ADD CONSTRAINT notification_kind_valid CHECK (kind IN (
  'task_assigned',          -- work handed to you
  'mentioned',              -- named in a thread
  'task_overdue',           -- your own work, past its date
  'task_awaiting_signoff',  -- submitted, waiting on a moderator
  'task_blocked',           -- the assignee is stuck on something
  'message_received',       -- a colleague wrote to you directly
  'client_message'          -- a client wrote in their support conversation
));
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The outbox columns
-- -----------------------------------------------------------------------------

ALTER TABLE notification
  ADD COLUMN IF NOT EXISTS emailed_at            timestamptz,
  -- Counted so a permanently failing address cannot be retried for ever, and
  -- so the failure is visible in the table rather than only in a log.
  ADD COLUMN IF NOT EXISTS email_attempts        smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_last_attempt_at timestamptz;
--> statement-breakpoint

COMMENT ON COLUMN notification.emailed_at IS
  'When this was successfully emailed. NULL means pending or not emailable.';
--> statement-breakpoint
COMMENT ON COLUMN notification.email_attempts IS
  'Attempts so far. The sweep gives up after three, leaving the row visible.';
--> statement-breakpoint

-- What the sweep asks for: unsent, recent, not exhausted. Partial, so it stays
-- small no matter how many notifications the table accumulates.
CREATE INDEX IF NOT EXISTS notification_mail_pending
  ON notification (created_at)
  WHERE emailed_at IS NULL AND email_attempts < 3;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- A message becomes a notification
-- -----------------------------------------------------------------------------

/*
 * Private messages, and a client writing in.
 *
 * NOT `app.notify()`, for two reasons that both matter.
 *
 * The first is the client. `app.notify` raises unless there is a signed-in
 * member of staff or bootstrap is on — correct for its own purposes, and fatal
 * here: a client posting in the portal has no app_user at all, so calling it
 * would abort THEIR message. A notification failure must never cost somebody
 * the thing they wrote. Everything below is wrapped so it cannot.
 *
 * The second is the dedupe. `app.notify` inserts; this needs to bump an
 * existing unread row so that a conversation is one line in an inbox rather
 * than one line per message.
 *
 * Channels are deliberately untouched. Being in a channel is not the same as
 * being written to, and `mentioned` already covers somebody naming you in one.
 */
CREATE OR REPLACE FUNCTION app.notify_on_message()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER because `notification` takes no INSERT from anybody: creation goes
-- through a function, by design. Guarded by having no arguments and no reach —
-- it reads the row it was fired on and writes to the people that row implies.
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_kind    text;
  v_thread  thread;
  v_other   uuid;
  v_actor   uuid := app.current_user_id();
  v_who     text;
  v_preview text;
BEGIN
  SELECT * INTO v_thread FROM thread WHERE id = NEW.thread_id;
  IF v_thread.id IS NULL THEN RETURN NEW; END IF;

  -- A withdrawn message is not news.
  IF NEW.withdrawn_at IS NOT NULL THEN RETURN NEW; END IF;

  /*
   * One line of it, and no more.
   *
   * The body goes in an email, and an email is the least private place this
   * system writes to — it leaves our server, sits on a mail host and lands in
   * whatever client the reader uses. A preview says who wrote and roughly what
   * about; the message itself stays where it was said.
   */
  v_preview := left(regexp_replace(coalesce(NEW.body, ''), '\s+', ' ', 'g'), 140);
  IF NEW.body IS NOT NULL AND length(NEW.body) > 140 THEN
    v_preview := v_preview || '…';
  END IF;
  IF coalesce(trim(v_preview), '') = '' OR v_preview = '(file)' THEN
    v_preview := 'Sent a file.';
  END IF;

  IF v_thread.kind = 'dm' THEN
    v_kind := 'message_received';
    -- The other participant, whichever side wrote.
    v_other := CASE WHEN v_thread.participant_a = NEW.author_id
                    THEN v_thread.participant_b ELSE v_thread.participant_a END;
    IF v_other IS NULL OR v_other = NEW.author_id THEN RETURN NEW; END IF;

    SELECT full_name INTO v_who FROM app_user WHERE id = NEW.author_id;

    BEGIN
      -- Bump the standing row for this conversation if there is an unread one.
      UPDATE notification
         SET created_at            = now(),
             title                 = coalesce(v_who, 'A colleague'),
             body                  = v_preview,
             actor_id              = NEW.author_id,
             actor_name            = v_who,
             -- Eligible to email again. The gap is the sweep's business.
             emailed_at            = NULL,
             email_attempts        = 0
       WHERE recipient_id = v_other
         AND kind         = 'message_received'
         AND entity_type  = 'thread'
         AND entity_id    = NEW.thread_id
         AND read_at IS NULL;

      IF NOT FOUND THEN
        INSERT INTO notification
          (recipient_id, kind, title, body, link, entity_type, entity_id,
           actor_id, actor_name)
        VALUES
          (v_other, v_kind, coalesce(v_who, 'A colleague'), v_preview,
           '/chat/' || NEW.thread_id::text, 'thread', NEW.thread_id,
           NEW.author_id, v_who);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Never at the cost of the message.
      NULL;
    END;

    RETURN NEW;
  END IF;

  IF v_thread.kind = 'support' THEN
    /*
     * A client wrote to us.
     *
     * Everyone who can answer, which is admin and moderator — Amin and Mohamed
     * Amine. Until now this fired the live stream, the edit window and a
     * timestamp, and told nobody: the one conversation with somebody outside
     * the company waiting for an answer was the one nobody was notified about.
     *
     * Only when a CLIENT wrote it. Our own replies in that thread are not news
     * to us.
     */
    IF NEW.author_contact_id IS NULL THEN RETURN NEW; END IF;

    BEGIN
      FOR v_other IN
        SELECT u.id FROM app_user u
         WHERE u.role IN ('admin','moderator')
           AND u.is_active AND u.is_assignable AND NOT u.is_service_account
      LOOP
        UPDATE notification
           SET created_at     = now(),
               title          = coalesce(NEW.author_name, 'A client'),
               body           = v_preview,
               actor_id       = NULL,
               actor_name     = NEW.author_name,
               emailed_at     = NULL,
               email_attempts = 0
         WHERE recipient_id = v_other
           AND kind         = 'client_message'
           AND entity_type  = 'thread'
           AND entity_id    = NEW.thread_id
           AND read_at IS NULL;

        IF NOT FOUND THEN
          INSERT INTO notification
            (recipient_id, kind, title, body, link, entity_type, entity_id,
             actor_id, actor_name)
          VALUES
            (v_other, 'client_message', coalesce(NEW.author_name, 'A client'),
             v_preview, '/chat/' || NEW.thread_id::text, 'thread', NEW.thread_id,
             NULL, NEW.author_name);
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.notify_on_message() IS
  'Turns a direct message into one standing inbox row per conversation, and a '
  'client''s support message into one for each person who can answer. Wrapped '
  'so a notification can never cost somebody the message they wrote.';
--> statement-breakpoint

DROP TRIGGER IF EXISTS message_notifies ON message;
--> statement-breakpoint
CREATE TRIGGER message_notifies
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION app.notify_on_message();

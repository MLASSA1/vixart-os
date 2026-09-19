-- =============================================================================
-- 0061 — Announce that a thread changed. Nothing about what changed.
--
-- The five-second poll is not slow because five seconds is a long time. It is
-- slow because it is a guess: eight people's browsers ask, all day, whether
-- anything happened, and almost every answer is no. The delay Amin sees is the
-- gap between a message being written and the next guess landing.
--
-- So the database says so instead. `NOTIFY` on every insert, edit and
-- withdrawal, and the application holds ONE listening connection that fans the
-- announcement out to whichever browsers are open.
--
-- WHAT THE PAYLOAD IS, AND WHY IT IS SO THIN.
--
-- A thread id. Not the body, not the author, not even whether it was an insert
-- or an edit.
--
-- The listening connection is a single shared one. It has no session, so it
-- has no identity, so row level security has nothing to hold it to — whatever
-- travels on that channel is visible to a process serving every signed-in
-- person at once. Anything with content in it would therefore be one routing
-- mistake away from the wrong reader.
--
-- A thread id is a nudge. The browser answers it by asking for the messages
-- through the ordinary authenticated route, under its own identity, with its
-- own policies. The fast path and the safe path are the same path — the stream
-- only removes the waiting.
--
-- `pg_notify` needs no privilege and this function reads nothing, so it is
-- SECURITY INVOKER like everything else that does not need to be otherwise.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.announce_thread_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Queued until COMMIT by PostgreSQL itself, so a listener is never told
  -- about a message that a rolled-back transaction never actually wrote.
  PERFORM pg_notify('vixart_chat', COALESCE(NEW.thread_id, OLD.thread_id)::text);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.announce_thread_change() IS
  'AFTER trigger: names the thread that changed, and nothing else. The payload '
  'travels on a connection with no identity, so it carries no content.';

DROP TRIGGER IF EXISTS message_announce ON message;

-- An edit and a withdrawal are as worth delivering as a new message: a
-- correction that arrives a minute late is read as the original.
CREATE TRIGGER message_announce
  AFTER INSERT OR UPDATE OF body, edited_at, withdrawn_at ON message
  FOR EACH ROW
  EXECUTE FUNCTION app.announce_thread_change();

-- An attachment lands in its own table after the message row, so a voice note
-- or an image would otherwise arrive on the next fallback poll rather than at
-- once — the message appears first and empty, then fills in.
CREATE OR REPLACE FUNCTION app.announce_attachment_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
BEGIN
  IF COALESCE(NEW.entity_type, OLD.entity_type) <> 'message' THEN
    RETURN NULL;
  END IF;

  SELECT m.thread_id INTO target
    FROM message m
   WHERE m.id = COALESCE(NEW.entity_id, OLD.entity_id);

  IF target IS NOT NULL THEN
    PERFORM pg_notify('vixart_chat', target::text);
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.announce_attachment_change() IS
  'AFTER trigger on attachment: nudges the thread a message attachment belongs '
  'to, so an image or a voice note arrives with its message rather than after.';

DROP TRIGGER IF EXISTS attachment_announce ON attachment;

CREATE TRIGGER attachment_announce
  AFTER INSERT ON attachment
  FOR EACH ROW
  EXECUTE FUNCTION app.announce_attachment_change();

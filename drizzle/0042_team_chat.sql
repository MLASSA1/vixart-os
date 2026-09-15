-- VIXART OS — team chat: threads, messages, unread marks.
--
-- Threads rather than one room, because a conversation about SILACOD's film is
-- not the same conversation as "who has the 24-70". A thread hangs off a
-- client, off a project, or off nothing in particular.
--
-- A message is a RECORD. Fifteen minutes to fix a typo, and after that it
-- stands; nothing is ever deleted. Same principle as the activity log, for the
-- same reason: a history that can be tidied is a history nobody can rely on.
--
-- Attachments deliberately reuse the existing `attachment` table, the existing
-- 25 MB ceiling, the existing MIME whitelist and the existing authenticated
-- route at /api/files/[id]. A second upload mechanism would be a second
-- ceiling to keep at 25 MB, a second whitelist to keep free of SVG and
-- archives, and a second path to secure. One is enough, and it is already
-- right.

-- ===========================================================================
-- 1. Threads.
-- ===========================================================================
CREATE TABLE thread (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL
                CONSTRAINT thread_kind_valid CHECK (kind IN ('general','company','project')),
  company_id    uuid REFERENCES company(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE CASCADE,
  title         text NOT NULL
                CONSTRAINT thread_title_present CHECK (length(trim(title)) > 0),
  created_by_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A thread points at exactly the one thing its kind says it does. Without
  -- this a 'project' thread could carry a company_id nothing ever reads, and
  -- the visibility policy below would silently consult the wrong parent.
  CONSTRAINT thread_target_matches_kind CHECK (
    (kind = 'general' AND company_id IS NULL AND project_id IS NULL)
    OR (kind = 'company' AND company_id IS NOT NULL AND project_id IS NULL)
    OR (kind = 'project' AND project_id IS NOT NULL AND company_id IS NULL)
  )
);

CREATE INDEX thread_by_company ON thread (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX thread_by_project ON thread (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX thread_recent     ON thread (updated_at DESC);

ALTER TABLE thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread FORCE ROW LEVEL SECURITY;

-- Not a person, not in the conversation.
CREATE FUNCTION app.is_real_person() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_user
     WHERE id = app.current_user_id()
       AND is_active AND is_assignable AND NOT is_service_account
  );
$$;

CREATE POLICY thread_bootstrap ON thread
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- Visibility follows the PARENT, expressed as a subquery rather than copied.
-- company and project both carry their own RLS, so "can I see this thread"
-- resolves to "can I see the thing it is about" — and if that ever narrows,
-- threads narrow with it, without anyone remembering to come back here.
CREATE POLICY thread_select ON thread FOR SELECT
  USING (
    app.is_real_person()
    AND (
      kind = 'general'
      OR (kind = 'company' AND EXISTS (SELECT 1 FROM company c WHERE c.id = thread.company_id))
      OR (kind = 'project' AND EXISTS (SELECT 1 FROM project p WHERE p.id = thread.project_id))
    )
  );

CREATE POLICY thread_insert ON thread FOR INSERT
  WITH CHECK (app.is_real_person() AND created_by_id = app.current_user_id());

-- Renaming a thread is allowed; the messages in it are not touched.
CREATE POLICY thread_update ON thread FOR UPDATE
  USING (app.is_real_person()) WITH CHECK (app.is_real_person());

-- No DELETE policy, deliberately. A conversation is not tidied away.

CREATE TRIGGER thread_touch_updated_at BEFORE UPDATE ON thread
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ===========================================================================
-- 2. Messages.
-- ===========================================================================
CREATE TABLE message (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  -- Frozen at send, like comment.author_name: the message should still say who
  -- wrote it after they leave and their account is deactivated.
  author_name text NOT NULL,
  body        text NOT NULL
              CONSTRAINT message_body_present CHECK (length(trim(body)) > 0),
  edited_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_by_thread ON message (thread_id, created_at);

ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE message FORCE ROW LEVEL SECURITY;

CREATE POLICY message_bootstrap ON message
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- A message is visible exactly when its thread is. The subquery is subject to
-- the thread policy above, so this inherits the parent rule rather than
-- restating it.
CREATE POLICY message_select ON message FOR SELECT
  USING (EXISTS (SELECT 1 FROM thread t WHERE t.id = message.thread_id));

CREATE POLICY message_insert ON message FOR INSERT
  WITH CHECK (
    app.is_real_person()
    AND author_id = app.current_user_id()
    AND EXISTS (SELECT 1 FROM thread t WHERE t.id = message.thread_id)
  );

-- Only your own, and the trigger below decides for how long.
CREATE POLICY message_update ON message FOR UPDATE
  USING (author_id = app.current_user_id())
  WITH CHECK (author_id = app.current_user_id());

-- No DELETE policy. Deletion is refused by the absence of permission rather
-- than by a trigger, which matters: a BEFORE DELETE trigger that raised would
-- also block the cascade when a client record is legitimately removed, and
-- would have to be disabled to let that through — a guard you have to switch
-- off is a guard that will be left off.

CREATE FUNCTION app.enforce_message_edit_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() THEN
    RETURN NEW;
  END IF;

  IF OLD.created_at < now() - interval '15 minutes' THEN
    RAISE EXCEPTION
      'A message can be corrected for fifteen minutes after sending. After that it stands.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The body is the only thing an edit may touch. Moving a message to another
  -- thread, or backdating it, would rewrite the conversation rather than fix a
  -- typo in it.
  IF NEW.thread_id  IS DISTINCT FROM OLD.thread_id
  OR NEW.author_id  IS DISTINCT FROM OLD.author_id
  OR NEW.author_name IS DISTINCT FROM OLD.author_name
  OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Only the text of a message can be corrected.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- An edited message says so. A silent correction is a rewritten record.
  NEW.edited_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_edit_window BEFORE UPDATE ON message
  FOR EACH ROW EXECUTE FUNCTION app.enforce_message_edit_window();

-- A new message lifts its thread, so the list sorts by real activity.
CREATE FUNCTION app.touch_thread_on_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE thread SET updated_at = now() WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_touches_thread AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION app.touch_thread_on_message();

-- ===========================================================================
-- 3. Unread — one timestamp per person per thread.
--
-- Not per-message receipts. Nobody needs to know that Adam read message 41 at
-- 14:02, and storing it would turn a chat into a surveillance log. A mark
-- saying "I have read up to here" answers the only question the interface
-- actually asks.
-- ===========================================================================
CREATE TABLE thread_read (
  thread_id    uuid NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

ALTER TABLE thread_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_read FORCE ROW LEVEL SECURITY;

CREATE POLICY thread_read_bootstrap ON thread_read
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- Your own mark, nobody else's — in either direction. You cannot read when a
-- colleague last opened a thread, and you cannot set it for them.
CREATE POLICY thread_read_own ON thread_read FOR ALL
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- ===========================================================================
-- 4. Attachments on a message.
-- ===========================================================================
ALTER TABLE attachment DROP CONSTRAINT IF EXISTS attachment_entity_type_valid;
ALTER TABLE attachment ADD CONSTRAINT attachment_entity_type_valid CHECK (
  entity_type IN ('task','project','company','document','finance_entry','contact','prep','message')
);

CREATE FUNCTION app.can_see_message(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM message m
      JOIN thread t ON t.id = m.thread_id
     WHERE m.id = p_id
       AND (
         t.kind = 'general'
         OR (t.kind = 'company' AND EXISTS (SELECT 1 FROM company c WHERE c.id = t.company_id))
         OR (t.kind = 'project' AND EXISTS (SELECT 1 FROM project p WHERE p.id = t.project_id))
       )
  );
$$;

-- A file posted into a thread is readable by whoever can read the thread, and
-- removable by nobody — it is part of the message.
CREATE POLICY attachment_message_read ON attachment FOR SELECT
  USING (entity_type = 'message' AND app.is_real_person() AND app.can_see_message(entity_id));

CREATE POLICY attachment_message_write ON attachment FOR INSERT
  WITH CHECK (
    entity_type = 'message'
    AND app.is_real_person()
    AND uploaded_by_id = app.current_user_id()
    AND app.can_see_message(entity_id)
  );

-- VIXART OS — notifications. In-app only; nothing here contacts anyone.
--
-- Four things are worth interrupting someone for: work handed to them, being
-- named in a conversation, their own work falling overdue, and work waiting on
-- their sign-off. Everything else is a screen they can go and look at.
--
-- A notification belongs to ONE person. Its visibility is its recipient — not
-- the thing it points at — so the inbox needs no joins to be safe, and a
-- notification cannot be read by someone it was not addressed to even if they
-- can see the underlying task.
--
-- That has a consequence worth stating: because RLS here checks the recipient
-- and NOT the parent, a notification must never be created for someone who
-- cannot open what it links to. There is no second line of defence. The row
-- would be perfectly visible to them and the link would 404.

CREATE TABLE notification (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  kind         text NOT NULL
               CONSTRAINT notification_kind_valid CHECK (kind IN (
                 'task_assigned',          -- work handed to you
                 'mentioned',              -- named in a thread
                 'task_overdue',           -- your own work, past its date
                 'task_awaiting_signoff'   -- submitted, waiting on a moderator
               )),

  -- Frozen at creation rather than joined at read time. A notification is a
  -- record of a moment: "Amin assigned you the Roastery edit" should still say
  -- that after the task is renamed or reassigned.
  title        text NOT NULL
               CONSTRAINT notification_title_present CHECK (length(trim(title)) > 0),
  body         text,
  link         text NOT NULL
               CONSTRAINT notification_link_internal CHECK (link ~ '^/'),

  /* What it is about — used to keep repeats down, never to decide visibility. */
  entity_type  text,
  entity_id    uuid,

  actor_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_name   text,

  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_inbox ON notification (recipient_id, created_at DESC);
CREATE INDEX notification_unread ON notification (recipient_id) WHERE read_at IS NULL;

-- One standing notification per person per thing, for the kinds that describe a
-- STATE rather than an event. A task does not become newly overdue each night.
CREATE UNIQUE INDEX notification_one_per_state
  ON notification (recipient_id, kind, entity_id)
  WHERE kind IN ('task_overdue','task_awaiting_signoff') AND entity_id IS NOT NULL;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_bootstrap ON notification
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- Yours, and only ever yours. Reading and marking read are the only things
-- anyone does to their own; nobody writes one directly, which is why there is
-- no INSERT here — creation goes through app.notify() below.
CREATE POLICY notification_own ON notification FOR SELECT
  USING (recipient_id = app.current_user_id());

CREATE POLICY notification_mark_read ON notification FOR UPDATE
  USING (recipient_id = app.current_user_id())
  WITH CHECK (recipient_id = app.current_user_id());

-- Nobody deletes a notification. It ages out of the inbox by being read.

-- ---------------------------------------------------------------------------
-- Creating one.
--
-- SECURITY DEFINER because the whole point is writing a row for somebody else,
-- which the policy above deliberately forbids. Guarded: only a real person can
-- cause a notification, and the actor is taken from the session rather than
-- from an argument, so it cannot be forged by a caller.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.notify(
  p_recipient   uuid,
  p_kind        text,
  p_title       text,
  p_link        text,
  p_body        text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id   uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_actor uuid := app.current_user_id();
BEGIN
  IF NOT app.is_authenticated() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only a signed-in person can raise a notification.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Never tell someone about their own action. A person knows what they did.
  IF p_recipient = v_actor THEN
    RETURN NULL;
  END IF;

  -- Not a person, no inbox.
  IF NOT EXISTS (
    SELECT 1 FROM app_user
     WHERE id = p_recipient AND is_active AND is_assignable AND NOT is_service_account
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO notification
    (recipient_id, kind, title, body, link, entity_type, entity_id, actor_id, actor_name)
  VALUES
    (p_recipient, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id,
     v_actor, (SELECT full_name FROM app_user WHERE id = v_actor))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Work handed to someone, and work waiting on a sign-off.
--
-- Triggers rather than application code: a task can be assigned from the
-- project screen, from the task row, or by a moderator editing it directly,
-- and a notification that depends on remembering to call it is a notification
-- that will be missed from the fourth place.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.notify_on_task_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_project text;
BEGIN
  IF NOT app.is_authenticated() AND NOT app.is_bootstrap() THEN
    RETURN NEW;   -- nothing to attribute it to
  END IF;

  SELECT name INTO v_project FROM project WHERE id = NEW.project_id;

  -- Assigned, or reassigned to somebody new.
  IF NEW.assignee_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) THEN
    PERFORM app.notify(
      NEW.assignee_id, 'task_assigned',
      NEW.title,
      '/my-work',
      coalesce(v_project, 'A project'),
      'task', NEW.id);
  END IF;

  -- Submitted for review: everyone who can sign it off should know.
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    PERFORM app.notify(
      u.id, 'task_awaiting_signoff',
      NEW.title,
      '/projects/' || NEW.project_id::text,
      'Submitted and waiting on a sign-off',
      'task', NEW.id)
      FROM app_user u
     WHERE u.role IN ('admin','moderator')
       AND u.is_active AND u.is_assignable AND NOT u.is_service_account;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER task_notifies AFTER INSERT OR UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION app.notify_on_task_change();

-- ---------------------------------------------------------------------------
-- Overdue is a state, not an event, so it is swept rather than triggered.
-- Called from scripts/nightly.sh. The partial unique index means a task that
-- has been overdue for a week produces one notification, not seven.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.notify_overdue_tasks(p_today date DEFAULT current_date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_made integer := 0; v_id uuid; t record;
BEGIN
  IF NOT app.is_admin() AND NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'Only management can sweep overdue work.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR t IN
    SELECT k.id, k.title, k.assignee_id, k.project_id
      FROM task k
     WHERE k.assignee_id IS NOT NULL
       AND k.due_date IS NOT NULL
       AND k.due_date < p_today
       AND k.status NOT IN ('completed','submitted')
  LOOP
    INSERT INTO notification
      (recipient_id, kind, title, body, link, entity_type, entity_id)
    VALUES
      (t.assignee_id, 'task_overdue', t.title, 'Past its due date', '/my-work', 'task', t.id)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN v_made := v_made + 1; v_id := NULL; END IF;
  END LOOP;

  RETURN v_made;
END;
$$;

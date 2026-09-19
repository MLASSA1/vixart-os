-- =============================================================================
-- 0058 — A person's own week, and their own notebook.
--
-- Two tables, both private to one person, both deliberately small.
--
-- SCHEDULE. A view over work that already exists, plus the things that are not
-- work. Tasks are NOT copied here: a task assigned to somebody appears on its
-- due date because the schedule reads the task table, and re-entering it would
-- create a second place where work lives and a second place to forget to
-- update.
--
-- What IS stored is everything a task cannot express — a shoot day, a client
-- meeting, a day off, a block of focus time. A personal entry has no assignee,
-- no status and no sign-off, and never becomes a task. If something needs an
-- owner and somebody to approve it, it is a task, and the interface says so
-- rather than letting the two blur.
--
-- NOTES. Somewhere to draft a script idea or a thought about a client before
-- it is ready to be said out loud. Private to the author and refused to
-- everyone else INCLUDING administrators — which is the point, and is asserted
-- by test. It is not where decisions go; those belong in a channel where the
-- people affected can read them.
-- =============================================================================

CREATE TABLE schedule_entry (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  title      text NOT NULL
             CONSTRAINT schedule_title_present CHECK (length(btrim(title)) > 0),

  kind       text NOT NULL DEFAULT 'block'
             CONSTRAINT schedule_kind_valid CHECK (kind IN (
               'shoot',     -- a shoot day
               'meeting',   -- a client or internal meeting
               'off',       -- not working
               'block'      -- focus time, or anything else
             )),

  starts_on  date NOT NULL,
  /* Null for a single day. Never before the start. */
  ends_on    date,
  CONSTRAINT schedule_range_ordered CHECK (ends_on IS NULL OR ends_on >= starts_on),

  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE schedule_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE schedule_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY schedule_entry_bootstrap ON schedule_entry
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

-- Yours, in both directions. A colleague cannot read that you booked a day off
-- and cannot put something in your week on your behalf. The team view that
-- moderators get reads TASKS, never this table.
CREATE POLICY schedule_entry_own ON schedule_entry FOR ALL
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint

CREATE INDEX schedule_entry_by_person ON schedule_entry (user_id, starts_on);
--> statement-breakpoint

CREATE TRIGGER schedule_entry_touch_updated_at
  BEFORE UPDATE ON schedule_entry
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint

-- -----------------------------------------------------------------------------

CREATE TABLE private_note (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  title      text NOT NULL
             CONSTRAINT private_note_title_present CHECK (length(btrim(title)) > 0),
  body       text NOT NULL DEFAULT '',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE private_note ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE private_note FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

/*
 * Deliberately NO bootstrap policy.
 *
 * Every other table has one so seeds and maintenance can reach it. A private
 * note has nothing to seed and nothing to migrate, and the door would be the
 * one way somebody's unfinished thoughts could be read by a script. The owner
 * role still holds BYPASSRLS — this cannot stop a determined database
 * administrator, and does not claim to. What it does is make sure no part of
 * THIS application can read them.
 */
CREATE POLICY private_note_own ON private_note FOR ALL
  USING (author_id = app.current_user_id())
  WITH CHECK (author_id = app.current_user_id());
--> statement-breakpoint

CREATE INDEX private_note_by_author ON private_note (author_id, updated_at DESC);
--> statement-breakpoint

CREATE TRIGGER private_note_touch_updated_at
  BEFORE UPDATE ON private_note
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

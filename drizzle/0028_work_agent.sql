-- =============================================================================
-- 0028 — Agent layer phase 2: task distribution.
--
-- Same shape as phase 1, one difference that matters: this agent has to WRITE
-- to existing rows. Assigning work IS an update. Phase 1 could refuse UPDATE
-- everywhere; here the grant has to be narrowed instead of withheld.
--
-- The narrowing is column-level. `vixart_agent_work` may update exactly three
-- columns on `task` — who it is for, when it is due, how urgent — and no
-- others. It cannot touch `status`, so it can never mark work done: that is the
-- two-step human sign-off, and it stays human.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Capacity — how much time someone actually has
--
-- Empty by default, and deliberately so. Nobody has told this system how many
-- hours a week Aymen works, and inventing a number would make every workload
-- percentage a fiction. While a person has no row here, the tools report load
-- as counts and minutes and say plainly that there is no capacity to compare
-- it against — the same treatment as the withholding rate in phase 1.
--
-- Versioned rather than edited: someone going part-time is a new row, so last
-- quarter's workload report still reads against the capacity that applied then.
-- -----------------------------------------------------------------------------

CREATE TABLE "capacity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  /* Minutes per week, integer — same reasoning as effort_log. */
  "weekly_minutes" integer NOT NULL,
  "effective_from" date NOT NULL DEFAULT current_date,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "capacity_minutes_positive" CHECK ("weekly_minutes" > 0),
  /* A week holds 10 080 minutes. Anything near that is a typo, not devotion. */
  CONSTRAINT "capacity_minutes_sane" CHECK ("weekly_minutes" <= 4200)
);
--> statement-breakpoint

ALTER TABLE "capacity" ADD CONSTRAINT "capacity_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE UNIQUE INDEX "capacity_user_from_key" ON "capacity" ("user_id", "effective_from");
--> statement-breakpoint

/* Versions are permanent, like prices and rates. Change means a new row. */
CREATE OR REPLACE FUNCTION app.forbid_capacity_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_bootstrap() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION
    'A capacity version is immutable (in force from %). Insert a new version '
    'with a later effective_from date instead.', OLD.effective_from
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "capacity_immutable" BEFORE UPDATE OR DELETE ON "capacity"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_capacity_rewrite();
--> statement-breakpoint

ALTER TABLE "capacity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "capacity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
/* The team can see what everyone's capacity is — it is how a fair split gets
   argued about. Only management sets it. */
CREATE POLICY "capacity_read" ON "capacity" FOR SELECT USING (app.is_authenticated());
--> statement-breakpoint
CREATE POLICY "capacity_write_admin" ON "capacity" FOR INSERT WITH CHECK (app.is_admin());
--> statement-breakpoint
CREATE POLICY "capacity_bootstrap" ON "capacity" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. The work agent's identity
-- -----------------------------------------------------------------------------

INSERT INTO app_user (email, full_name, job_title, role, password_hash, is_active, must_change_password)
VALUES ('chef@vixart.local', 'Le Chef', 'Work agent', 'member',
        'NO-LOGIN-service-account-no-password-accepted', true, false)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.work_agent_user_id() RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT id FROM app_user WHERE email = 'chef@vixart.local';
$$;
--> statement-breakpoint

/* Definer for the same reason as app.agent_user_id() in 0027: the agent cannot
   read app_user, and the RLS policies below call this function. 0026 shipped
   that mistake; this one does not repeat it. */

CREATE OR REPLACE FUNCTION app.is_work_agent() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() = 'work_agent';
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Read policies
-- -----------------------------------------------------------------------------

CREATE POLICY "company_work_agent_read"  ON "company"   FOR SELECT USING (app.is_work_agent());
--> statement-breakpoint
CREATE POLICY "project_work_agent_read"  ON "project"   FOR SELECT USING (app.is_work_agent());
--> statement-breakpoint
CREATE POLICY "task_work_agent_read"     ON "task"      FOR SELECT USING (app.is_work_agent());
--> statement-breakpoint
CREATE POLICY "effort_work_agent_read"   ON "effort_log" FOR SELECT USING (app.is_work_agent());
--> statement-breakpoint
CREATE POLICY "capacity_work_agent_read" ON "capacity"  FOR SELECT USING (app.is_work_agent());
--> statement-breakpoint
CREATE POLICY "comment_work_agent_read"  ON "comment"   FOR SELECT USING (app.is_work_agent());
--> statement-breakpoint

-- Notably absent: document, document_line, finance_entry, service_price,
-- fiscal_rate, declaration, recurring_entry. The work agent has no business
-- knowing what anything costs, and no policy gives it a way to find out.

-- -----------------------------------------------------------------------------
-- 4. Write policies — create a task, assign it, move its date
-- -----------------------------------------------------------------------------

CREATE POLICY "task_work_agent_insert" ON "task" FOR INSERT
  WITH CHECK (
    app.is_work_agent()
    /* A new task starts unstarted. The agent cannot open one already done. */
    AND "status" = 'todo'
    AND "created_by_id" = app.work_agent_user_id()
  );
--> statement-breakpoint

CREATE POLICY "task_work_agent_update" ON "task" FOR UPDATE
  USING (app.is_work_agent())
  WITH CHECK (app.is_work_agent());
--> statement-breakpoint

CREATE POLICY "comment_work_agent_insert" ON "comment" FOR INSERT
  WITH CHECK (
    app.is_work_agent()
    AND "author_id" = app.work_agent_user_id()
  );
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. The line the agent cannot cross
--
-- The RLS policy above permits UPDATE on a task, and the column grant in
-- scripts/apply-grants.ts limits it to assignee/due date/priority. Grants are
-- checked per statement, so an UPDATE naming `status` is refused outright —
-- but a grant is invisible when you are reading the policy, and this rule is
-- important enough to say twice, in the place someone will look.
--
-- Marking work done is the two-step human sign-off. It stays human.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.enforce_work_agent_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.is_work_agent() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'The work agent cannot change a task''s status. Submitting and signing off '
      'are done by people.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id
  OR NEW.title      IS DISTINCT FROM OLD.title
  OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION
      'The work agent can reassign and reschedule a task, not rewrite what it is.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "task_work_agent_limits" BEFORE UPDATE ON "task"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_work_agent_limits();

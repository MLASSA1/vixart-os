-- =============================================================================
-- 0060 — Direct messages. One to one, and nobody else's business.
--
-- WHY THIS REUSES `thread` RATHER THAN BUILDING A SECOND CHAT.
--
-- Messages already carry: a fifteen-minute edit window, withdrawal with a
-- tombstone, attachments through an authenticated route, read marks, mention
-- parsing and the polling that draws them. A parallel set of tables would mean
-- a second copy of every one of those rules, free to drift from the first —
-- and the drift would be silent, because nobody tests the rule they forgot to
-- copy.
--
-- So a DM is a thread of kind 'dm' with two participants, and everything
-- downstream works unchanged.
--
-- WHERE THE BOUNDARY IS.
--
-- Visibility is RLS on participant identity, not a filter in a query. That
-- distinction is the whole design: a page that forgets to filter shows a
-- person their own DMs in the wrong list, which is untidy. A page that forgets
-- a filter where the filter IS the security shows them somebody else's
-- conversation. Here the database refuses — to a colleague, and to an
-- administrator, who has no more claim on two people's private conversation
-- than anybody else.
--
-- ONE TO ONE, and no way to grow. Two columns rather than a participant table:
-- a join table is how a one-to-one conversation quietly becomes a group chat
-- two phases later, and group DMs are the thing that turns a small team's tool
-- into a place where decisions are made where the rest of the team cannot see
-- them.
-- =============================================================================

ALTER TABLE thread ADD COLUMN participant_a uuid REFERENCES app_user(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE thread ADD COLUMN participant_b uuid REFERENCES app_user(id) ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE thread DROP CONSTRAINT thread_kind_valid;
--> statement-breakpoint
ALTER TABLE thread ADD CONSTRAINT thread_kind_valid
  CHECK (kind IN ('general', 'company', 'project', 'dm'));
--> statement-breakpoint

-- A DM points at two people and at no client or project; every other kind
-- points at neither person. Keeping both halves in one constraint means a row
-- cannot be half one thing and half another.
ALTER TABLE thread DROP CONSTRAINT thread_target_matches_kind;
--> statement-breakpoint

ALTER TABLE thread ADD CONSTRAINT thread_target_matches_kind CHECK (
     (kind = 'general' AND company_id IS NULL AND project_id IS NULL
        AND participant_a IS NULL AND participant_b IS NULL)
  OR (kind = 'company' AND company_id IS NOT NULL AND project_id IS NULL
        AND participant_a IS NULL AND participant_b IS NULL)
  OR (kind = 'project' AND project_id IS NOT NULL AND company_id IS NULL
        AND participant_a IS NULL AND participant_b IS NULL)
  OR (kind = 'dm' AND company_id IS NULL AND project_id IS NULL
        AND participant_a IS NOT NULL AND participant_b IS NOT NULL
        AND participant_a <> participant_b)
);
--> statement-breakpoint

/*
 * One conversation per pair, whichever way round it was opened.
 *
 * Without this, Aya messaging Adam and Adam messaging Aya produce two threads
 * and each of them sees half the conversation — which looks like messages
 * going missing.
 */
CREATE UNIQUE INDEX thread_one_dm_per_pair
  ON thread (least(participant_a, participant_b), greatest(participant_a, participant_b))
  WHERE kind = 'dm';
--> statement-breakpoint

CREATE INDEX thread_dm_by_participant
  ON thread (participant_a, participant_b) WHERE kind = 'dm';
--> statement-breakpoint

-- --- visibility --------------------------------------------------------------

DROP POLICY thread_select ON thread;
--> statement-breakpoint

CREATE POLICY thread_select ON thread FOR SELECT USING (
  app.is_real_person() AND (
       (kind = 'general')
    OR (kind = 'company' AND EXISTS (SELECT 1 FROM company c WHERE c.id = thread.company_id))
    OR (kind = 'project' AND EXISTS (SELECT 1 FROM project p WHERE p.id = thread.project_id))
    -- Yours only. No role, no exception: an administrator has no more claim on
    -- two people's private conversation than anyone else does.
    OR (kind = 'dm' AND app.current_user_id() IN (participant_a, participant_b))
  )
);
--> statement-breakpoint

DROP POLICY thread_insert ON thread;
--> statement-breakpoint

CREATE POLICY thread_insert ON thread FOR INSERT WITH CHECK (
  app.is_real_person()
  AND created_by_id = app.current_user_id()
  AND (
    -- A DM is opened BY one of its two participants, and by nobody else.
    -- Anyone may open one: it is a conversation, not a privilege.
    (kind = 'dm' AND app.current_user_id() IN (participant_a, participant_b))
    OR (kind <> 'dm' AND (
         app.is_moderator()
         OR (is_default AND (
               (kind = 'project'
                AND EXISTS (SELECT 1 FROM project p WHERE p.id = thread.project_id))
            OR (kind = 'company'
                AND EXISTS (SELECT 1 FROM company c
                             WHERE c.id = thread.company_id AND c.status = 'client'))
         ))
       ))
  )
);
--> statement-breakpoint

DROP POLICY thread_update ON thread;
--> statement-breakpoint

-- Renaming a DM is meaningless — its name is the other person — and letting a
-- thread be edited into or out of being one would be a way around every rule
-- above.
CREATE POLICY thread_update ON thread FOR UPDATE
  USING (app.is_real_person() AND kind <> 'dm')
  WITH CHECK (app.is_real_person() AND kind <> 'dm');
--> statement-breakpoint

/*
 * Both participants must be real people.
 *
 * A service account has no inbox and nobody behind it; a DM addressed to one
 * would be a conversation held with nothing. Checked in a trigger because a
 * CHECK constraint cannot read another table.
 */
CREATE FUNCTION app.enforce_dm_participants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'dm' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_user
     WHERE id = NEW.participant_b
       AND is_active AND is_assignable AND NOT is_service_account
  ) THEN
    RAISE EXCEPTION 'You can only message an active member of the team.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_user
     WHERE id = NEW.participant_a
       AND is_active AND is_assignable AND NOT is_service_account
  ) THEN
    RAISE EXCEPTION 'You can only message an active member of the team.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A DM is never one of the automatic channels, whatever it was sent as.
  NEW.is_default := false;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER thread_dm_participants
  BEFORE INSERT OR UPDATE ON thread
  FOR EACH ROW EXECUTE FUNCTION app.enforce_dm_participants();

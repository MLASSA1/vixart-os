-- =============================================================================
-- 0072 — A person has a face, a banner and something to say about themselves.
--
-- Amin asked for members to be able to change their name, set a profile picture,
-- add a banner, and write a description — so that clicking a colleague shows who
-- they are, what they do here, and that description.
--
-- This reverses an earlier decision, deliberately and on his instruction. The
-- chat avatars carry a comment saying there is no upload flow because profile
-- pictures mean a second thing to store, moderate, back up and serve, for eight
-- people who already know each other by name. That reasoning was sound and it is
-- overruled: the people using it want faces, and a system its users find cold is
-- not a well-engineered system.
--
-- WHERE THE BYTES GO.
--
-- In `attachment`, like everything else. The alternative — a column on app_user
-- holding a path — would be a second file store with its own rules about size,
-- type, authorisation and serving, and the one that gets forgotten is always the
-- second one. Two new entity types, and a unique index so a person has exactly
-- one picture and exactly one banner rather than a pile of them.
--
-- WHAT A PERSON MAY CHANGE ABOUT THEMSELVES.
--
-- `app_user_update` already admits `id = app.current_user_id()`, and
-- `app_user_team_rules` (0021) already refuses self-edits of role, is_active and
-- email — so name and the new description need no new grant and no new function.
-- `job_title` stays where it is: it is the company's statement about somebody,
-- not their own, and it is already editable on the team page by an admin.
-- =============================================================================

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS bio text;
--> statement-breakpoint

/*
 * Long enough to say who you are, short enough that nobody writes an essay
 * into a sidebar. Trimmed to NULL rather than stored as an empty string, so
 * "has a description" is one test and not two.
 */
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_bio_sane;
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_bio_sane
  CHECK (bio IS NULL OR (length(bio) <= 600 AND length(trim(bio)) > 0));
--> statement-breakpoint

COMMENT ON COLUMN app_user.bio IS
  'What this person says about themselves, shown on their profile. Their own to '
  'write: app_user_update admits id = app.current_user_id().';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The two new kinds of attachment
-- -----------------------------------------------------------------------------

ALTER TABLE attachment DROP CONSTRAINT attachment_entity_type_valid;
--> statement-breakpoint

ALTER TABLE attachment ADD CONSTRAINT attachment_entity_type_valid CHECK (
  entity_type = ANY (ARRAY[
    'task', 'project', 'company', 'contact', 'document', 'finance_entry',
    'prep', 'message',
    -- A person's own picture and the strip behind it. `entity_id` is an app_user.
    'user_avatar', 'user_banner'
  ])
);
--> statement-breakpoint

/*
 * One face, one banner.
 *
 * Without this, changing a picture would leave the old row behind and the join
 * would have two answers — and which one you saw would depend on the plan.
 * The interface deletes before it inserts; this makes that the only possibility
 * rather than a convention.
 */
CREATE UNIQUE INDEX IF NOT EXISTS attachment_one_per_person
  ON attachment (entity_type, entity_id)
  WHERE entity_type IN ('user_avatar', 'user_banner');
--> statement-breakpoint

/*
 * Seen by colleagues, changed only by its owner.
 *
 * A face is the one thing in this system that is meant to be looked at by
 * everybody who can sign in — that is what it is for. Writing is narrower than
 * the read: `entity_id = app.current_user_id()` means the check is the row's own
 * identity and there is no argument anybody can aim somewhere else. An admin can
 * also remove one, because a picture is the one upload here that can be a
 * problem in a way a spreadsheet cannot.
 */
CREATE POLICY attachment_profile_read ON attachment FOR SELECT
  USING (
    entity_type IN ('user_avatar', 'user_banner')
    AND app.is_authenticated()
  );
--> statement-breakpoint

CREATE POLICY attachment_profile_write ON attachment FOR INSERT
  WITH CHECK (
    entity_type IN ('user_avatar', 'user_banner')
    AND app.is_real_person()
    AND entity_id = app.current_user_id()
    -- Attributed to the person whose face it is. Anything else would be a claim
    -- that somebody else uploaded it.
    AND uploaded_by_id = app.current_user_id()
  );
--> statement-breakpoint

CREATE POLICY attachment_profile_delete ON attachment FOR DELETE
  USING (
    entity_type IN ('user_avatar', 'user_banner')
    AND (entity_id = app.current_user_id() OR app.is_admin())
  );
--> statement-breakpoint

/*
 * A deleted account takes its picture with it.
 *
 * `attachment.entity_id` is polymorphic and has no foreign key, which is how
 * notifications came to outlive their threads (0071). Same trigger, same
 * reasoning — except here what is left behind is an image file nobody can
 * reach and nobody knows to delete.
 */
CREATE OR REPLACE FUNCTION app.forget_profile_images_for()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER because the delete policy above is written for the owner deleting
-- their own, and this runs when the owner no longer exists. Takes no argument
-- and can only affect rows naming the row being deleted.
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM attachment
   WHERE entity_type IN ('user_avatar', 'user_banner')
     AND entity_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.forget_profile_images_for() IS
  'Removes a deleted person''s picture and banner. EXEMPT from the '
  'definer-caller check: no arguments, no data returned, and it can only affect '
  'rows naming the app_user row being deleted.';
--> statement-breakpoint

DROP TRIGGER IF EXISTS app_user_forgets_profile_images ON app_user;
--> statement-breakpoint
CREATE TRIGGER app_user_forgets_profile_images
  AFTER DELETE ON app_user
  FOR EACH ROW EXECUTE FUNCTION app.forget_profile_images_for();
--> statement-breakpoint

/*
 * The directory gains what a profile needs.
 *
 * A view rather than four joins written out at each of the places that render a
 * person: the team list, a profile page, the chat avatars and the private list.
 * `has_avatar` is a boolean and not the id, because the interface asks the
 * avatar route for the bytes by PERSON — one url per person, cacheable, and no
 * query anywhere needs to carry an attachment id around to draw a face.
 */
CREATE OR REPLACE VIEW app.team_directory AS
  SELECT id,
         full_name,
         job_title,
         role,
         is_active,
         is_assignable AND NOT is_service_account AS is_person,
         bio,
         EXISTS (SELECT 1 FROM attachment a
                  WHERE a.entity_type = 'user_avatar' AND a.entity_id = app_user.id) AS has_avatar,
         EXISTS (SELECT 1 FROM attachment a
                  WHERE a.entity_type = 'user_banner' AND a.entity_id = app_user.id) AS has_banner
    FROM app_user;

-- VIXART OS — the prep board.
--
-- Somewhere for each person to gather what a video needs before it is shot:
-- the idea, the script, the shot list, references, locations, music. One
-- rule shapes the whole thing:
--
--   while it is being prepared it is PRIVATE, and the moment it is marked
--   ready the rest of the team can read it.
--
-- That is deliberate and it is the point. Half-formed work read over your
-- shoulder stops being half-formed work and starts being a performance —
-- people either stop writing anything down or only write down what is already
-- safe. A draft nobody can see is a draft you can be wrong in.
--
-- Privacy here means EVERYONE, management included. Amin can see a draft the
-- moment its owner marks it ready and not before, the same as anyone else.
-- This is the one place in the system where being the founder does not come
-- with a key, and it only works if that is true.

CREATE TABLE prep (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CONSTRAINT prep_title_present CHECK (length(trim(title)) > 0),
  kind        text NOT NULL DEFAULT 'idea'
              CONSTRAINT prep_kind_valid
              CHECK (kind IN ('idea','script','shotlist','moodboard','location','music','other')),
  body        text,
  /* Optional: prep can exist before there is a project to hang it on. */
  project_id  uuid REFERENCES project(id) ON DELETE SET NULL,
  company_id  uuid REFERENCES company(id) ON DELETE SET NULL,
  owner_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  status      text NOT NULL DEFAULT 'draft'
              CONSTRAINT prep_status_valid CHECK (status IN ('draft','ready')),
  ready_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX prep_by_owner  ON prep (owner_id, status);
CREATE INDEX prep_shared    ON prep (status, ready_at DESC) WHERE status = 'ready';
CREATE INDEX prep_by_project ON prep (project_id) WHERE project_id IS NOT NULL;

ALTER TABLE prep ENABLE ROW LEVEL SECURITY;
ALTER TABLE prep FORCE ROW LEVEL SECURITY;

CREATE POLICY prep_bootstrap ON prep USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- The whole rule, in one clause: your own, or anybody's once it is ready.
CREATE POLICY prep_read ON prep FOR SELECT
  USING (
    app.is_authenticated()
    AND (owner_id = app.current_user_id() OR status = 'ready')
  );

-- You may only create prep in your own name.
CREATE POLICY prep_insert ON prep FOR INSERT
  WITH CHECK (app.is_authenticated() AND owner_id = app.current_user_id());

-- Only the owner edits it. Nobody rewrites someone else's preparation —
-- reading it and commenting on it is what the rest of the team gets.
CREATE POLICY prep_update ON prep FOR UPDATE
  USING (app.is_authenticated() AND owner_id = app.current_user_id())
  WITH CHECK (owner_id = app.current_user_id());

-- Delete: the owner, or an admin clearing up after someone who has left.
CREATE POLICY prep_delete ON prep FOR DELETE
  USING (app.is_admin() OR owner_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- Stamps.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.stamp_prep_ready() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ready' AND coalesce(OLD.status, 'draft') <> 'ready' THEN
    NEW.ready_at := now();
  ELSIF NEW.status = 'draft' THEN
    -- Pulled back to draft: it disappears from the team again, and the date it
    -- was shared should not survive to claim otherwise.
    NEW.ready_at := NULL;
  END IF;

  -- The owner is who wrote it. Not transferable — an author is a fact.
  IF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Preparation stays with the person who wrote it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER prep_stamp BEFORE INSERT OR UPDATE ON prep
  FOR EACH ROW EXECUTE FUNCTION app.stamp_prep_ready();

CREATE TRIGGER prep_touch_updated_at BEFORE UPDATE ON prep
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Files and comments follow the prep they belong to.
--
-- Without this, a draft's attachments and comments would be readable by
-- everyone while the prep itself was hidden — the private half of the rule
-- leaking through its own accessories.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.can_see_prep(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM prep
     WHERE id = p_id
       AND (owner_id = app.current_user_id() OR status = 'ready')
  );
$$;

CREATE FUNCTION app.owns_prep(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM prep WHERE id = p_id AND owner_id = app.current_user_id()
  );
$$;

ALTER TABLE attachment DROP CONSTRAINT IF EXISTS attachment_entity_type_valid;
ALTER TABLE attachment ADD CONSTRAINT attachment_entity_type_valid CHECK (
  entity_type IN ('task','project','company','document','finance_entry','contact','prep')
);

CREATE POLICY attachment_prep_read ON attachment FOR SELECT
  USING (entity_type = 'prep' AND app.can_see_prep(entity_id));

CREATE POLICY attachment_prep_write ON attachment FOR INSERT
  WITH CHECK (entity_type = 'prep' AND app.owns_prep(entity_id));

CREATE POLICY attachment_prep_delete ON attachment FOR DELETE
  USING (entity_type = 'prep' AND app.owns_prep(entity_id));

-- Comments were readable by any signed-in person for any entity at all. That
-- was harmless while every commentable thing was itself visible to everyone;
-- it is not harmless now. Narrowed so a prep's comments obey the prep.
DROP POLICY IF EXISTS comment_select ON comment;
CREATE POLICY comment_select ON comment FOR SELECT
  USING (
    app.is_authenticated()
    AND (entity_type <> 'prep' OR app.can_see_prep(entity_id))
  );

DROP POLICY IF EXISTS comment_insert ON comment;
CREATE POLICY comment_insert ON comment FOR INSERT
  WITH CHECK (
    app.is_authenticated()
    AND author_id = app.current_user_id()
    -- You cannot comment on prep you cannot see, which for a draft means only
    -- its owner — a note to yourself in your own notebook.
    AND (entity_type <> 'prep' OR app.can_see_prep(entity_id))
  );

-- Comments carry their own whitelist of what can be commented on. Prep needs
-- to be in it, or the policies above guard a door nothing can reach.
ALTER TABLE comment DROP CONSTRAINT IF EXISTS comment_entity_type_valid;
ALTER TABLE comment ADD CONSTRAINT comment_entity_type_valid CHECK (
  entity_type IN ('task','project','company','deal','document','contact','prep')
);

-- =============================================================================
-- 0086 — What a client is shown of their project.
--
-- Amin asked for the portal's project page to show progress, what comes next,
-- and the files we have delivered. Progress exists (0065). The other two did
-- not, and neither can be taken from what we already store without showing a
-- client things written for us:
--
--   * WHAT COMES NEXT is not the next task. Task titles are our working notes
--     ("chase Hassan for the logo files", "re-export, colour is off") and a
--     client is not shown the task table at all (0064). So it is one sentence,
--     written FOR the client, on the project: `next_step`.
--
--   * A DELIVERED FILE is not every file on the project. Rough cuts, contracts
--     and reference images sit there too. So a file is shown to the client
--     only when somebody has said so: `attachment.shared_with_client`, false
--     by default, and only possible on a project's files.
--
-- Sharing is done through one narrow function rather than an UPDATE policy:
-- an UPDATE policy on `attachment` would let the same person rewrite
-- `stored_path`, and a row pointing at another file is a way to hand a client
-- something that was never shared.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- What comes next
-- -----------------------------------------------------------------------------

ALTER TABLE project
  ADD COLUMN next_step        text,
  ADD COLUMN next_step_set_at timestamptz,
  ADD CONSTRAINT project_next_step_shape CHECK (
    next_step IS NULL OR length(btrim(next_step)) BETWEEN 1 AND 300
  );

COMMENT ON COLUMN project.next_step IS
  'One sentence, written for the client, on what happens next. Shown in the '
  'portal as written. Not derived from tasks: task titles are internal.';

GRANT SELECT (next_step, next_step_set_at) ON project TO vixart_client;

-- -----------------------------------------------------------------------------
-- Delivered files
-- -----------------------------------------------------------------------------

ALTER TABLE attachment
  ADD COLUMN shared_with_client boolean NOT NULL DEFAULT false,
  ADD COLUMN shared_at          timestamptz,
  ADD CONSTRAINT attachment_shared_only_from_a_project CHECK (
    NOT shared_with_client OR entity_type = 'project'
  ),
  ADD CONSTRAINT attachment_shared_has_a_date CHECK (
    shared_with_client = (shared_at IS NOT NULL)
  );

COMMENT ON COLUMN attachment.shared_with_client IS
  'A project file the client may see and download in the portal. False until '
  'somebody chooses to share it; only possible on a project''s files.';

CREATE INDEX attachment_shared_project_idx ON attachment (entity_id)
  WHERE shared_with_client;

-- The portal's file route selects every column it knows about, so the client
-- role must be able to read these two; what it may read ROWS of is below.
GRANT SELECT (shared_with_client, shared_at) ON attachment TO vixart_client;

CREATE POLICY attachment_client_delivered ON attachment FOR SELECT TO vixart_client
  USING (
    entity_type = 'project'
    AND shared_with_client
    AND EXISTS (
      SELECT 1 FROM project p
       WHERE p.id = attachment.entity_id
         AND p.company_id = app.current_client_company()
         AND p.archived_at IS NULL
    )
  );

/*
 * Share or unshare a project file. A producer or an administrator, nobody
 * else, and only the flag and its date move. SECURITY DEFINER because no
 * staff UPDATE policy exists on `attachment` and none should.
 */
CREATE OR REPLACE FUNCTION app.share_with_client(p_attachment uuid, p_shared boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  kind text;
BEGIN
  IF NOT app.is_moderator() THEN
    RAISE EXCEPTION 'Only a producer or an administrator can share a file with a client.'
      USING ERRCODE = '42501';
  END IF;

  SELECT entity_type INTO kind FROM attachment WHERE id = p_attachment;
  IF kind IS NULL THEN
    RAISE EXCEPTION 'That file does not exist.' USING ERRCODE = 'P0002';
  END IF;
  IF kind <> 'project' THEN
    RAISE EXCEPTION 'Only a project''s files can be shared with the client.' USING ERRCODE = '22023';
  END IF;

  UPDATE attachment
     SET shared_with_client = p_shared,
         shared_at = CASE WHEN p_shared THEN coalesce(shared_at, now()) ELSE NULL END
   WHERE id = p_attachment;
END;
$$;

REVOKE ALL ON FUNCTION app.share_with_client(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_with_client(uuid, boolean) TO vixart_app;

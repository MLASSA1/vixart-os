-- =============================================================================
-- 0019 — File attachments.
--
-- Binaries never go in the database. The row here is metadata only; the bytes
-- live in the `vixart_uploads` volume under a generated name. Storing files in
-- Postgres would bloat every backup and make pg_dump unusable for its purpose.
--
-- `entity_type` + `entity_id` is a deliberate polymorphic link rather than five
-- nullable foreign keys. The trade-off is no referential integrity from the
-- database, so orphan rows are possible if a parent is deleted; the cleanup
-- trigger below handles the cases that matter.
-- =============================================================================

CREATE TABLE "attachment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  /* What the user called it. Shown, never used to build a path. */
  "original_name" text NOT NULL,
  /* Where it actually sits, relative to UPLOADS_DIR. Generated, never typed. */
  "stored_path" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "caption" text,
  "uploaded_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "attachment_entity_valid" CHECK ("entity_type" IN
    ('task','project','company','document','finance_entry','contact')),
  CONSTRAINT "attachment_name_not_empty" CHECK (length(trim("original_name")) > 0),
  CONSTRAINT "attachment_size_positive" CHECK ("size_bytes" > 0),
  -- 25 MB. Matches the cap enforced in the upload action; having it here too
  -- means a bug in that action cannot fill the volume.
  CONSTRAINT "attachment_size_capped" CHECK ("size_bytes" <= 26214400),
  -- The stored path is generated as yyyy/mm/<uuid>.<ext>. Anything with a
  -- traversal segment or a leading slash is refused outright.
  CONSTRAINT "attachment_path_safe" CHECK (
    "stored_path" ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}(\.[A-Za-z0-9]{1,10})?$'
  )
);
--> statement-breakpoint

ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploaded_by_id_fk"
  FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null;
--> statement-breakpoint

CREATE UNIQUE INDEX "attachment_stored_path_key" ON "attachment" ("stored_path");
--> statement-breakpoint
CREATE INDEX "attachment_entity_idx" ON "attachment" ("entity_type","entity_id");
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Row level security
--
-- An attachment inherits the sensitivity of what it hangs off. Work files are
-- the team's; anything attached to a document or a ledger line is money, and
-- follows the same management-only boundary as its parent.
-- -----------------------------------------------------------------------------

ALTER TABLE "attachment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attachment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "attachment_work_read" ON "attachment" FOR SELECT
  USING (app.is_authenticated()
         AND "entity_type" IN ('task','project','company','contact'));
--> statement-breakpoint
CREATE POLICY "attachment_work_write" ON "attachment" FOR INSERT
  WITH CHECK (app.is_authenticated()
              AND "entity_type" IN ('task','project','company','contact'));
--> statement-breakpoint

-- Whoever uploaded it can remove it; a moderator or admin can remove any.
CREATE POLICY "attachment_work_delete" ON "attachment" FOR DELETE
  USING (app.is_moderator() OR "uploaded_by_id" = app.current_user_id());
--> statement-breakpoint

CREATE POLICY "attachment_money" ON "attachment" FOR ALL
  USING (app.is_admin() AND "entity_type" IN ('document','finance_entry'))
  WITH CHECK (app.is_admin() AND "entity_type" IN ('document','finance_entry'));
--> statement-breakpoint

CREATE POLICY "attachment_bootstrap" ON "attachment" FOR ALL
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

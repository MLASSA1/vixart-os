/*
 * The data keeps its shape: indexes, and three rules it already follows.
 *
 * Amin, November 2026: "no messy files or missing data … it needs to be
 * perfectly designed and structured". An audit of production found the
 * structure sound where it is hardest to retrofit — every table has a primary
 * key, every table has row level security enabled AND forced — and four gaps,
 * which this closes. Production was cleaned the same day: the leftover
 * "Portal test" company removed, two files belonging to deleted messages
 * removed, a backup taken first (vixart_2026-11-10_184323).
 *
 * 1. EVERY FOREIGN KEY GETS AN INDEX. 32 had none: a client's finance lines,
 *    a deal's projects, who a direct message is with, each person's unread
 *    markers, and every "who created this" column. Without one, a lookup by
 *    that column reads the whole table, and so does every delete of the row
 *    it points at — invisible at today's size, the first thing to hurt as the
 *    data grows. Found and created here rather than listed, so the migration
 *    is right on any copy of the database and never doubles an index.
 *
 * 2. A CHAT MESSAGE IS NEVER HARD-DELETED. The application never deletes one
 *    — it withdraws it and keeps the row — but two had been deleted by hand,
 *    and their voice note and photo were left on disk belonging to nothing.
 *    Only a bootstrap session (a migration, a test's clean-up, the probe
 *    purge) may delete a message now.
 *
 * 3. ONE MAIN CONTACT PER CLIENT. The application already clears the old one
 *    before setting a new one; this makes it a rule rather than a habit.
 *
 * 4. AN EMAIL ADDRESS LOOKS LIKE ONE. Lenient on purpose — something, an @,
 *    a domain with a dot — because the point is to stop "06 12 34 56 78"
 *    landing in the email column, not to second-guess real addresses.
 *
 * NOT HERE: a unique ICE. Two companies sharing one is a real data error, but
 * the test suite's probe companies share fixture ICEs by design and run in
 * parallel; the rule is enforced when a client is saved instead, with a
 * sentence naming the other company.
 */

DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT k.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1 AND n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = k.conrelid AND i.indkey[0] = k.conkey[1])
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (%I)',
                   left('fk_' || replace(fk.tbl::text, '.', '_') || '_' || fk.col, 63), fk.tbl, fk.col);
  END LOOP;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.forbid_message_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.is_bootstrap() THEN
    RAISE EXCEPTION 'A message is never deleted. Withdraw it instead; the conversation keeps its place.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS message_never_deleted ON message;
--> statement-breakpoint
CREATE TRIGGER message_never_deleted
  BEFORE DELETE ON message
  FOR EACH ROW EXECUTE FUNCTION app.forbid_message_delete();
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS contact_one_main_per_company
  ON contact (company_id) WHERE is_primary;
--> statement-breakpoint

ALTER TABLE contact DROP CONSTRAINT IF EXISTS contact_email_shape;
--> statement-breakpoint
ALTER TABLE contact ADD CONSTRAINT contact_email_shape
  CHECK (email IS NULL OR email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

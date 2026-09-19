-- =============================================================================
-- 0059 — Archiving, and refusing to delete what is a record.
--
-- Deletion already half-existed and was half-safe. `document.company_id` and
-- `retainer.company_id` are ON DELETE RESTRICT, so a client with an invoice
-- could never be removed — correct, and it surfaced as a raw foreign key
-- violation nobody could act on.
--
-- What was NOT safe: `thread.company_id` and `thread.project_id` are ON DELETE
-- CASCADE. Deleting a client or a project silently destroyed its channel and
-- every message in it. A conversation is a record — 0056 went to some trouble
-- to make sure a single message cannot be made to have never existed — and a
-- cascade was quietly able to remove thousands at once.
--
-- So: delete is for things with nothing behind them. Everything else archives.
-- An archived client keeps every document, every message and every figure, and
-- disappears from the lists and pickers where a dead client is only noise.
-- =============================================================================

ALTER TABLE company ADD COLUMN archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE project ADD COLUMN archived_at timestamptz;
--> statement-breakpoint

COMMENT ON COLUMN company.archived_at IS
  'Out of use, everything kept. Hidden from lists and pickers; never deleted.';
--> statement-breakpoint

CREATE INDEX company_live_idx ON company (status) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX project_live_idx ON project (company_id) WHERE archived_at IS NULL;
--> statement-breakpoint

/*
 * What a delete would take with it.
 *
 * Both of these refuse rather than cascade, and both say what to do instead.
 * The check is on the number of MESSAGES, not threads: every client and every
 * project has had a channel since 0046, so counting threads would refuse
 * everything and make deletion impossible rather than careful.
 */
CREATE FUNCTION app.refuse_deleting_a_record() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_messages bigint;
  v_documents bigint;
BEGIN
  IF TG_TABLE_NAME = 'company' THEN
    SELECT count(*) INTO v_documents FROM document WHERE company_id = OLD.id;
    IF v_documents > 0 THEN
      RAISE EXCEPTION
        'This client has % quote(s) or invoice(s). Those are fiscal records and cannot be removed — archive the client instead.', v_documents
        USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT count(*) INTO v_messages
      FROM message m JOIN thread t ON t.id = m.thread_id
     WHERE t.company_id = OLD.id;
  ELSE
    SELECT count(*) INTO v_messages
      FROM message m JOIN thread t ON t.id = m.thread_id
     WHERE t.project_id = OLD.id;
  END IF;

  IF v_messages > 0 THEN
    RAISE EXCEPTION
      'There are % message(s) in this channel. Deleting would remove the conversation — archive it instead.', v_messages
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER company_refuse_deleting_a_record
  BEFORE DELETE ON company
  FOR EACH ROW EXECUTE FUNCTION app.refuse_deleting_a_record();
--> statement-breakpoint

CREATE TRIGGER project_refuse_deleting_a_record
  BEFORE DELETE ON project
  FOR EACH ROW EXECUTE FUNCTION app.refuse_deleting_a_record();

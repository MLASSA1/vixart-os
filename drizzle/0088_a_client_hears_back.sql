-- =============================================================================
-- 0088 — A client hears back.
--
-- When a client writes, the team is told by email (notify_on_message, support
-- branch). When the team replies, the client was told nothing: the reply sat
-- in the portal until they happened to sign in. This sends them an email.
--
-- WHY NOT THE `notification` TABLE. A notification belongs to an app_user —
-- `recipient_id` references it, and every policy on it reads "the recipient
-- is the signed-in member of staff". A client is a contact, deliberately not
-- an app_user (0064). So client mail gets its own outbox, shaped the same way:
-- triggers write rows, the existing sweep (scripts/notification-mail.ts)
-- collects them, and a send never runs inside somebody's transaction.
--
-- ONE EMAIL FOR A BURST. A row stays open per contact and conversation until
-- it is sent; three replies in a minute bump it to "3 replies", not three
-- emails. The sweep waits until the conversation has been quiet for a few
-- minutes, and if the client has read the replies in the portal meanwhile it
-- sends nothing at all.
--
-- THE CLIENT CAN TURN IT OFF, from their Account page. `client_account` is not
-- readable or writable by the client role (0064), so the setting is read and
-- written through two narrow functions on their own account only.
-- =============================================================================

ALTER TABLE client_account
  ADD COLUMN email_replies boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN client_account.email_replies IS
  'Whether this client is emailed when the team replies in their conversation. '
  'Theirs to change, from the portal''s Account page.';

CREATE TABLE client_reply_mail (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            uuid NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  thread_id             uuid NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  replies               integer NOT NULL DEFAULT 1,
  -- One line of the latest reply. An email is the least private place this
  -- system writes to, so it never carries the whole message.
  preview               text NOT NULL,
  author_name           text,
  first_reply_at        timestamptz NOT NULL DEFAULT now(),
  last_reply_at         timestamptz NOT NULL DEFAULT now(),
  emailed_at            timestamptz,
  -- Read in the portal before it was sent, so it never was.
  skipped_at            timestamptz,
  email_attempts        integer NOT NULL DEFAULT 0,
  email_last_attempt_at timestamptz,
  CONSTRAINT client_reply_mail_replies_positive CHECK (replies > 0),
  CONSTRAINT client_reply_mail_attempts_sane CHECK (email_attempts >= 0),
  CONSTRAINT client_reply_mail_preview_short CHECK (length(preview) BETWEEN 1 AND 160),
  CONSTRAINT client_reply_mail_one_outcome CHECK (emailed_at IS NULL OR skipped_at IS NULL),
  CONSTRAINT client_reply_mail_order CHECK (last_reply_at >= first_reply_at)
);

COMMENT ON TABLE client_reply_mail IS
  'Outbox: one pending email per client contact and conversation, telling them '
  'the team has replied. Written by a trigger on message; sent by the mail sweep.';

-- One open email per contact and conversation: the burst rule above.
CREATE UNIQUE INDEX client_reply_mail_one_pending
  ON client_reply_mail (contact_id, thread_id)
  WHERE emailed_at IS NULL AND skipped_at IS NULL;

CREATE INDEX client_reply_mail_due
  ON client_reply_mail (last_reply_at)
  WHERE emailed_at IS NULL AND skipped_at IS NULL;

CREATE INDEX client_reply_mail_thread_idx ON client_reply_mail (thread_id);

ALTER TABLE client_reply_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_reply_mail FORCE ROW LEVEL SECURITY;

CREATE POLICY client_reply_mail_bootstrap ON client_reply_mail
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- Administrators can see what went out, and to whom. Nobody writes to it
-- through the application: the trigger and the sweep do.
CREATE POLICY client_reply_mail_admin_read ON client_reply_mail FOR SELECT
  USING (app.is_admin());

GRANT SELECT ON client_reply_mail TO vixart_app;

-- -----------------------------------------------------------------------------
-- The trigger: a member of staff wrote in a support conversation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.queue_client_reply_mail() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_thread  thread;
  v_contact uuid;
  v_preview text;
BEGIN
  -- Only our replies. A client's own message is not news to them.
  IF NEW.author_id IS NULL OR NEW.withdrawn_at IS NOT NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_thread FROM thread WHERE id = NEW.thread_id;
  IF v_thread.id IS NULL OR v_thread.kind <> 'support' OR v_thread.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_preview := left(regexp_replace(coalesce(NEW.body, ''), '\s+', ' ', 'g'), 140);
  IF length(coalesce(NEW.body, '')) > 140 THEN v_preview := v_preview || '…'; END IF;
  IF coalesce(btrim(v_preview), '') = '' OR v_preview = '(file)' THEN
    v_preview := 'Sent you a file.';
  END IF;

  BEGIN
    FOR v_contact IN
      SELECT ct.id
        FROM contact ct
        JOIN client_account ca ON ca.contact_id = ct.id
        JOIN company co ON co.id = ct.company_id
       WHERE ct.company_id = v_thread.company_id
         AND ca.is_active AND ca.email_replies
         AND co.archived_at IS NULL
         AND coalesce(btrim(ct.email), '') <> ''
    LOOP
      UPDATE client_reply_mail
         SET replies = replies + 1,
             preview = v_preview,
             author_name = NEW.author_name,
             last_reply_at = now()
       WHERE contact_id = v_contact AND thread_id = NEW.thread_id
         AND emailed_at IS NULL AND skipped_at IS NULL;

      IF NOT FOUND THEN
        INSERT INTO client_reply_mail (contact_id, thread_id, preview, author_name)
        VALUES (v_contact, NEW.thread_id, v_preview, NEW.author_name);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- Never at the cost of the message.
    NULL;
  END;

  RETURN NEW;
END;
$$;

CREATE TRIGGER message_queues_client_mail
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION app.queue_client_reply_mail();

-- -----------------------------------------------------------------------------
-- The client's own switch
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.own_reply_emails() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT email_replies FROM client_account WHERE contact_id = app.current_client_contact();
$$;

CREATE OR REPLACE FUNCTION app.set_own_reply_emails(p_on boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  UPDATE client_account SET email_replies = p_on
   WHERE contact_id = app.current_client_contact();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sign in again to change this.' USING ERRCODE = '42501';
  END IF;
  -- Turned off: nothing already waiting goes out either.
  IF NOT p_on THEN
    UPDATE client_reply_mail SET skipped_at = now()
     WHERE contact_id = app.current_client_contact()
       AND emailed_at IS NULL AND skipped_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.queue_client_reply_mail() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.own_reply_emails() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_own_reply_emails(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.own_reply_emails() TO vixart_client;
GRANT EXECUTE ON FUNCTION app.set_own_reply_emails(boolean) TO vixart_client;

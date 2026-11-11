-- =============================================================================
-- 0087 — A client knows what is new, and that we have read them.
--
-- The team already gets a notification when a client writes (notify_on_message,
-- support branch). The client got nothing back: no count of replies they have
-- not seen, and no sign that anybody had read what they sent — so the natural
-- thing to do after a quiet afternoon was to send it again, or phone.
--
-- Two small things:
--
--   * `client_thread_read`: when THIS contact last opened their conversation.
--     Their own row only. From it the portal counts replies since.
--   * `app.support_seen_by_team_at()`: the last time anyone on the team opened
--     the client's conversation, as one timestamp. A definer function rather
--     than a grant on `thread_read`, which holds every staff member's reading
--     of every internal conversation; the client gets one number about theirs.
-- =============================================================================

CREATE TABLE client_thread_read (
  contact_id   uuid NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, thread_id)
);

CREATE INDEX client_thread_read_thread_idx ON client_thread_read (thread_id);

COMMENT ON TABLE client_thread_read IS
  'When a client contact last opened a support conversation. Written by the '
  'contact themselves; read by the team to show that a reply was seen.';

ALTER TABLE client_thread_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_thread_read FORCE ROW LEVEL SECURITY;

CREATE POLICY client_thread_read_bootstrap ON client_thread_read
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());

-- The client: their own row, on their own support thread, and nothing else.
CREATE POLICY client_thread_read_own ON client_thread_read TO vixart_client
  USING (contact_id = app.current_client_contact())
  WITH CHECK (
    contact_id = app.current_client_contact()
    AND EXISTS (
      SELECT 1 FROM thread t
       WHERE t.id = client_thread_read.thread_id
         AND t.kind = 'support'
         AND t.company_id = app.current_client_company()
    )
  );

-- The team: read, to say "seen" under a reply.
CREATE POLICY client_thread_read_staff ON client_thread_read FOR SELECT
  USING (app.is_real_person());

GRANT SELECT, INSERT, UPDATE ON client_thread_read TO vixart_client;
GRANT SELECT ON client_thread_read TO vixart_app;

/*
 * The last time anyone on the team opened this client's support conversation.
 * One timestamp, for the signed-in client's own thread; NULL when nobody has.
 */
CREATE OR REPLACE FUNCTION app.support_seen_by_team_at() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT max(r.last_read_at)
    FROM thread t
    JOIN thread_read r ON r.thread_id = t.id
   WHERE t.kind = 'support'
     AND t.company_id = app.current_client_company();
$$;

REVOKE ALL ON FUNCTION app.support_seen_by_team_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.support_seen_by_team_at() TO vixart_client;

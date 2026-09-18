-- =============================================================================
-- 0053 — Reaching somebody who is not looking at the app.
--
-- Until now a notification was a number in the sidebar, computed when a
-- signed-in person loaded a page. Somebody signed out, or with the tab closed,
-- learned nothing — which is most of the day.
--
-- This is the first thing in VIXART OS that contacts the outside world, and it
-- was forbidden until Amin lifted that rule deliberately on 18 September 2026.
-- What actually leaves the box is narrow: an encrypted blob to a push endpoint
-- the browser chose (Google, Mozilla or Apple). The payload is sealed with keys
-- only that browser holds, so the push service learns that a message exists for
-- a subscription and never its contents — not the client's name, not the text.
--
-- A subscription is a device, not a person: one member signing in on a phone
-- and a laptop has two. They expire on their own, and the sender is told when
-- they do (404/410), which is the only reliable way to know — so rows are
-- deleted on that signal rather than kept forever.
-- =============================================================================

CREATE TABLE push_subscription (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  -- The browser's own URL for this device. Unique: re-subscribing the same
  -- device must update the row, never add a second one that double-notifies.
  endpoint    text NOT NULL UNIQUE
              CONSTRAINT push_endpoint_https CHECK (endpoint ~ '^https://'),

  -- The device's public key and auth secret. These are what make the payload
  -- readable only by that browser; the server cannot decrypt what it sends.
  p256dh      text NOT NULL,
  auth        text NOT NULL,

  /* For a person recognising a device in a list they can revoke from. */
  label       text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz
);
--> statement-breakpoint

ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_subscription FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY push_subscription_bootstrap ON push_subscription
  USING (app.is_bootstrap()) WITH CHECK (app.is_bootstrap());
--> statement-breakpoint

-- Your own devices, nobody else's, in either direction. A colleague must not be
-- able to enumerate what somebody signs in on, and must not be able to register
-- a device against another person's account and receive their notifications.
CREATE POLICY push_subscription_own ON push_subscription FOR ALL
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint

CREATE INDEX push_subscription_by_user ON push_subscription (user_id);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- What has been delivered.
--
-- Notifications are created in three places — a trigger on task changes, the
-- nightly overdue sweep, and the chat mention parser — and two of those are
-- pure SQL with no application code involved. So delivery cannot hang off the
-- call sites: a worker reads what is undelivered and sends it, which covers
-- every source including any added later without their having to remember.
-- -----------------------------------------------------------------------------

ALTER TABLE notification ADD COLUMN pushed_at timestamptz;
--> statement-breakpoint

COMMENT ON COLUMN notification.pushed_at IS
  'When this was pushed to the recipient''s devices. Null means the worker has not taken it yet.';
--> statement-breakpoint

-- The worker''s only query: the undelivered, oldest first. Partial, because
-- everything ever delivered is dead weight in this index.
CREATE INDEX notification_undelivered
  ON notification (created_at)
  WHERE pushed_at IS NULL;

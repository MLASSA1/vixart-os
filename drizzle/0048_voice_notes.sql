-- =============================================================================
-- 0048 — How long a voice note is.
--
-- One column, and only because nothing else can hold this.
--
-- A voice note recorded in the browser arrives as WebM/Opus, and MediaRecorder
-- writes that container without a duration in its header — the length is not
-- known until the whole stream has been decoded, so an <audio> element reports
-- Infinity until it has fetched and scanned the entire file. A player that
-- cannot say "0:14" before you press play is not a voice note, it is a file
-- with a triangle next to it.
--
-- The browser DOES know the duration: it just recorded it, by the clock. So it
-- is sent with the upload and kept here, next to the bytes it describes.
--
-- Nullable, because every attachment that is not audio has no duration, and a
-- voice note whose duration failed to arrive should still play.
-- =============================================================================

ALTER TABLE attachment ADD COLUMN duration_ms integer;
--> statement-breakpoint

COMMENT ON COLUMN attachment.duration_ms IS
  'Playing time in milliseconds, for audio. Measured by the recorder, because WebM/Opus from MediaRecorder carries no duration in its header.';
--> statement-breakpoint

-- A duration is either absent or real. The upper bound is the recorder's own
-- five-minute cap with room to spare: a longer recording is a file to attach,
-- not something anyone should hold a microphone button for.
ALTER TABLE attachment
  ADD CONSTRAINT attachment_duration_sane
  CHECK (duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 3600000));

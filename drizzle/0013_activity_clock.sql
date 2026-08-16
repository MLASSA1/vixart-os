-- =============================================================================
-- 0013 — Order the activity log correctly within a transaction.
--
-- `now()` returns the TRANSACTION start time, so several activity rows written
-- by triggers in one transaction all share a timestamp and cannot be ordered
-- against each other. Creating a deal and moving it two stages produced three
-- rows with identical created_at, and the feed showed them in arbitrary order.
--
-- `clock_timestamp()` reads the actual wall clock at each insert, so the
-- sequence is preserved. This only affects the activity log — everywhere else,
-- transaction time is the correct choice precisely because it is stable.
-- =============================================================================

ALTER TABLE "activity" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
--> statement-breakpoint

-- Existing rows written in the same transaction are indistinguishable; nudge
-- them apart by insertion order so the first feed render is not arbitrary.
UPDATE "activity" a
   SET "created_at" = a."created_at" + (r.n * interval '1 millisecond')
  FROM (SELECT "id", row_number() OVER (PARTITION BY "created_at" ORDER BY "id") AS n
          FROM "activity") r
 WHERE a."id" = r."id" AND r.n > 1;

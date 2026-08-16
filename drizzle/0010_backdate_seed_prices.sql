-- =============================================================================
-- 0010 — Backdate the seeded 0 DH price versions, and drop the unused
--        `relationship` concept.
--
-- (a) 0009 stamped every seeded price with `current_date`. That makes the very
--     first real price change collide with the seed row on the
--     (service_id, effective_from) unique index — the normal first action on
--     the screen failed. Backdating the seed to the start of the year frees
--     today, and reads more honestly: the 0 was never a decision taken today.
--
--     Price versions are immutable by trigger, deliberately. Correcting seed
--     data is the one legitimate reason to step around that, so the trigger is
--     disabled for exactly these two statements and re-enabled immediately.
--     Do NOT copy this pattern to change a real price — add a version instead.
--
-- (b) VIXART is the one providing the services: there are no suppliers or
--     vendors, only clients at different stages. The `relationship` column is
--     therefore pinned to 'client' and dropped from the interface. The column
--     is kept (not dropped) so no data is destroyed and a subcontractor could
--     be tracked later without another migration.
-- =============================================================================

ALTER TABLE "service_price" DISABLE TRIGGER "service_price_immutable";
--> statement-breakpoint

UPDATE "service_price"
   SET "effective_from" = DATE '2026-01-01',
       "note" = 'Catalog created at 0 DH — pricing to be set by the founder.'
 WHERE "unit_price_centimes" = 0
   AND "note" = 'Starting price — to be set by the founder.';
--> statement-breakpoint

ALTER TABLE "service_price" ENABLE TRIGGER "service_price_immutable";
--> statement-breakpoint

UPDATE "company" SET "relationship" = 'client' WHERE "relationship" <> 'client';

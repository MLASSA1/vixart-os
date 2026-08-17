-- =============================================================================
-- 0024 — A recurring template with history cannot be deleted.
--
-- 0022 made finance_entry.recurring_entry_id ON DELETE SET NULL, on the
-- reasoning that the posted lines should outlive the template. They should —
-- but nulling the link leaves an automatic line with no stated source, which
-- 0023 forbids, so the DELETE failed outright and the button did nothing but
-- raise. Caught by the integration test rather than by a client.
--
-- The rule that is actually wanted is the same one used for team members:
-- something that has left a trace is retired, not erased. A template that has
-- posted is stopped; only one that never posted can be removed. Both stay
-- possible, and the screen says which applies.
-- =============================================================================

ALTER TABLE "finance_entry" DROP CONSTRAINT IF EXISTS "finance_recurring_entry_id_fk";
--> statement-breakpoint

ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_recurring_entry_id_fk"
  FOREIGN KEY ("recurring_entry_id") REFERENCES "public"."recurring_entry"("id")
  ON DELETE RESTRICT;

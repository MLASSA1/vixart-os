-- =============================================================================
-- 0023 — An automatic ledger line may come from a template, not only an invoice.
--
-- 0016 required every automatic line to name a document:
--     CHECK (NOT is_automatic OR document_id IS NOT NULL)
-- which was right when a paid invoice was the only thing that could write one.
-- Recurring costs are automatic too and have a template instead, so the rule
-- became "recurring costs cannot be posted" — caught the first time the
-- catch-up ran.
--
-- The point of the original constraint stands and is kept: an automatic line
-- must always say what produced it. There are now two answers.
-- =============================================================================

ALTER TABLE "finance_entry" DROP CONSTRAINT IF EXISTS "finance_auto_has_document";
--> statement-breakpoint

ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_auto_has_source" CHECK (
  NOT "is_automatic"
  OR "document_id" IS NOT NULL
  OR "recurring_entry_id" IS NOT NULL
);
--> statement-breakpoint

-- And a line can only come from one of them, never both.
ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_single_source" CHECK (
  "document_id" IS NULL OR "recurring_entry_id" IS NULL
);

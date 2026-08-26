-- =============================================================================
-- 0031 — Agents write to the activity log like everyone else.
--
-- The `activity_insert` policy was written when only people acted, so it checks
-- app.is_authenticated() — which is deliberately false for every agent role.
-- The result: an agent could hold INSERT on the table and still be refused by
-- the policy, so creating a task failed at the audit step.
--
-- The right answer is not to exempt agents from logging. It is the opposite:
-- an agent that can act without leaving a trail is worse than one that cannot
-- act. So they get the same append-only INSERT as everyone, and the log records
-- them by name — "Le Chef", "Le Comptable" — beside the humans.
-- =============================================================================

CREATE POLICY "activity_agent_insert" ON "activity" FOR INSERT
  WITH CHECK (app.is_agent() OR app.is_work_agent());
--> statement-breakpoint

-- Reading the log is a separate question, and the answer is no: an agent has no
-- business reviewing who did what. It writes its own line and moves on.

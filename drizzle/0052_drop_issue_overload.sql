-- =============================================================================
-- 0052 — One issue_document, not two.
--
-- 0051 added the waiver parameter with CREATE OR REPLACE. That does not replace
-- anything when the signature changes: it creates a SECOND function, and
-- PostgreSQL then refuses every two-argument call as ambiguous because it could
-- mean either the two-argument function or the three-argument one with its
-- default. Every caller broke at once —
--
--   function app.issue_document(unknown, unknown) is not unique
--
-- which at least fails loudly rather than silently picking one. The same trap
-- was avoided deliberately in 0049 by dropping first, and then walked into here.
-- =============================================================================

DROP FUNCTION IF EXISTS app.issue_document(uuid, text);

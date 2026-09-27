-- =============================================================================
-- 0069 — Client contact details are management's.
--
-- Amin asked, twice in one message, that everybody except him and Mohamed Amine
-- lose the client list, the leads, the projects board, the dashboard, the money,
-- the quotes and invoices and the retainers.
--
-- Most of that is already true at this layer and needs nothing here: `deal` and
-- `retainer` are `app.is_moderator()`, `document` and `finance_entry` are
-- `app.is_admin()`. The pages are now closed as well, by the `(management)`
-- route group — but pages are the cheap layer, and the point of this file is
-- the one that holds when a page is written carelessly.
--
-- WHAT CHANGES: `contact`. It held `app.is_authenticated()`, so any member could
-- read every client's people — names, addresses, telephone numbers. That is the
-- actual substance of "the clients list", and nothing a member does needs it:
-- the only code that reads `contact` is the dashboard, the system page and the
-- client-account actions, all three management now.
--
-- WHAT DOES NOT CHANGE, AND WHY — `company` and `project`.
--
-- A member's own task says which project it belongs to and which client that
-- project is for, and they have to be able to read that or the task is a title
-- with no context. `/tasks`, `/my-work`, `/prep` and the project channels in
-- chat all join `company`. Closing the rows would not hide the book of business
-- from them; it would blank out the name of the job they are doing today.
--
-- So the rule is: they may read the name attached to their own work, and they
-- may not open the page that lists every client, every lead and every project.
-- The first is this file leaving those two policies alone. The second is the
-- route group. Written down because the difference is a judgement, not an
-- oversight, and the next person deserves to know which.
-- =============================================================================

DROP POLICY IF EXISTS contact_select ON contact;
--> statement-breakpoint

CREATE POLICY contact_select ON contact FOR SELECT
  USING (app.is_moderator());
--> statement-breakpoint

COMMENT ON TABLE contact IS
  'The people at a client. Readable by management only (0069): a member has no '
  'use for a client''s telephone number, and this is the table that made the '
  'clients list worth closing.';

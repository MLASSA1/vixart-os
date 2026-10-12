-- =============================================================================
-- 0076 — Tasks in the order somebody numbered them.
--
-- "Fix the task counting, they appear messy, they need to be in numeric order."
--
-- WHAT WAS ACTUALLY HAPPENING, because the number explains it better than the
-- complaint does.
--
-- 128 of 141 task titles are numbered. They arrive in series — "TASK 1" to
-- "TASK 18", "Task 01" to "Task 20", bare "1" to "16", "Portal test step 1" to
-- "5" — and Adam holds three of those series at once, 46 tasks in total.
--
-- The lists ordered by status, then priority, then due date, then
-- `created_at DESC`. For a numbered plan that is close to the worst possible
-- order:
--
--   * `created_at DESC` REVERSES it. A plan written 01, 02, 03 … is read back
--     20, 19, 18 …
--   * priority cuts it into bands, so Task 05 and Task 15 (normal) fall below
--     Task 20 (high) — the sequence is not just reversed, it is shuffled.
--   * and where the order falls through to the title, `ORDER BY title` is
--     LEXICOGRAPHIC: "TASK 10" sorts before "TASK 2", because '1' < '2'. Only
--     18 of the 141 titles are zero-padded, so padding does not save it.
--
-- Nobody had to be careless for this. Every one of those clauses is reasonable
-- on its own, and together they take a numbered plan and scramble it.
--
-- WHY A DATABASE FUNCTION rather than an ORDER BY in each page.
--
-- Three pages order tasks — /tasks, /my-work and the schedule's overlay — and a
-- regular expression copied into three ORDER BY clauses is three chances to
-- write it differently. It also has to be PLANNABLE: the guard that EXPLAINs
-- every query in this project cannot plan an ORDER BY assembled from an
-- interpolated fragment, which is how an earlier attempt at sharing one came
-- back. A function is interpolation-free at the call site and has one
-- definition.
--
-- IMMUTABLE, so it can be indexed the day the table is big enough to want it.
-- 141 rows sort in well under a millisecond, so there is no index here yet;
-- adding one later needs no other change.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.task_sort_key(p_title text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT
    /*
     * Three parts, concatenated into one sortable string.
     *
     * 1. THE PREFIX, exactly as written. Everything before the first digit.
     *    This keeps each series contiguous, and the case is deliberately NOT
     *    folded: Adam has both a "TASK n" series and a "Task n" series, and
     *    lowercasing the prefix merges them into one 1,1,2,2,3,3 interleave —
     *    which is messier than what we started with. Tried it, looked at it,
     *    kept the case.
     *
     * 2. THE FIRST NUMBER, zero-padded to nine digits so that comparing the
     *    text compares the value: '000000002' < '000000010'. Nine digits is
     *    past any task number anybody will type and short of an overflow.
     *
     *    `nullif(..., p_title)` is how "has no number" is detected:
     *    regexp_replace returns the subject UNCHANGED when the pattern does not
     *    match, so a title with no digits comes back as itself. Those sort as 0.
     *
     * 3. THE WHOLE TITLE, as the tie-break. Two tasks numbered 7 in the same
     *    series then have a stable order instead of whatever the plan returned
     *    that time — an unstable sort is its own kind of mess, because the list
     *    rearranges itself between page loads for no reason the reader can see.
     */
    regexp_replace(p_title, '[0-9].*$', '')
    || lpad(
         coalesce(
           nullif(regexp_replace(p_title, '^[^0-9]*([0-9]{1,9}).*$', '\1'), p_title),
           '0'),
         9, '0')
    || p_title
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.task_sort_key(text) IS
  'Natural sort key for a task title: the prefix as written, then the first '
  'number zero-padded so text order is numeric order, then the title as a '
  'stable tie-break. Keeps each numbered series contiguous and in sequence. '
  'Used by every list that orders tasks, so they cannot disagree.';
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.task_sort_key(text) TO PUBLIC;

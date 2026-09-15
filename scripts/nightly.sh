#!/bin/sh
# VIXART OS — nightly jobs, run inside the `backup` container.
#
# It already wakes once a night and already has psql, so it is where scheduled
# work belongs. Adding a scheduler container for one query would be more moving
# parts than the job deserves.
#
# Everything here must be safe to run twice: the container restarts, the host
# reboots, someone runs it by hand. Nothing may double-count.
set -eu

echo "[nightly] $(date '+%F %T') — starting"

# Fixed charges are NOT posted here any more.
#
# They used to post themselves on their due day, which is a claim that money
# left the account made by a calendar rather than by a bank. Rent paid late, or
# skipped, still showed as paid. They are now confirmed on the Finance page,
# one tick per charge per month, and the ledger line carries the date and the
# amount that actually moved.

# --- Draft this month's retainer invoices -------------------------------------
#
# Safe to automate BECAUSE it produces drafts. A draft has no number, no legal
# standing and moves no money — it is paperwork prepared for a person to check.
# Issuing stays a human act, and nothing here will ever do it.
#
# Idempotent by construction: document has a unique index on
# (retainer_id, retainer_period), so a month can be drafted once however many
# times this runs, restarts, or is triggered by hand from the Retainers screen.
DRAFTED=$(psql -qtAX -c "SET app.bootstrap = 'on'; SELECT app.draft_retainer_invoices();" 2>&1 | tail -1)
if [ "${DRAFTED}" -eq "${DRAFTED}" ] 2>/dev/null; then
  echo "[nightly] retainer drafts created: ${DRAFTED}"
else
  echo "[nightly] retainer drafting FAILED: ${DRAFTED}"
fi

# --- Notify on work that has fallen overdue -----------------------------------
#
# Overdue is a STATE, not an event, so it is swept rather than triggered. The
# partial unique index means a task overdue for a week produces one
# notification rather than seven — nobody reads the seventh.
OVERDUE=$(psql -qtAX -c "SET app.bootstrap = 'on'; SELECT app.notify_overdue_tasks();" 2>&1 | tail -1)
if [ "${OVERDUE}" -eq "${OVERDUE}" ] 2>/dev/null; then
  echo "[nightly] overdue notifications raised: ${OVERDUE}"
else
  echo "[nightly] overdue sweep FAILED: ${OVERDUE}"
fi

# --- Back up ------------------------------------------------------------------
sh /usr/local/bin/backup.sh

echo "[nightly] $(date '+%F %T') — done"

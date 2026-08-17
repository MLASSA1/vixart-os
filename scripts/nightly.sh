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

# --- 1. Post recurring costs that have fallen due ---------------------------
#
# Idempotent by construction: finance_entry has a unique index on
# (recurring_entry_id, period_key), so a period can only ever be posted once.
# It catches up every missed period, so a stack that was off for three weeks
# comes back with three weeks of rent recorded rather than one.
POSTED=$(psql -qtAX -c "SET app.bootstrap = 'on'; SELECT app.post_due_recurring();" 2>&1 | tail -1)
if [ "${POSTED}" -eq "${POSTED}" ] 2>/dev/null; then
  echo "[nightly] recurring entries posted: ${POSTED}"
else
  echo "[nightly] recurring posting FAILED: ${POSTED}"
fi

# --- 2. Back up ---------------------------------------------------------------
sh /usr/local/bin/backup.sh

echo "[nightly] $(date '+%F %T') — done"

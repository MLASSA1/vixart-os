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

# --- Back up ------------------------------------------------------------------
sh /usr/local/bin/backup.sh

echo "[nightly] $(date '+%F %T') — done"

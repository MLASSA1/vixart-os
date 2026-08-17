#!/bin/sh
# VIXART OS — nightly daemon for the `backup` container.
#
# One run immediately at start-up, so a broken chain shows now rather than at
# 3am, then one per night at $BACKUP_HOUR, Africa/Casablanca time.
#
# Each run posts any recurring costs that have fallen due, then takes the
# backup — in that order, so the dump contains the night's postings.
set -eu

BACKUP_HOUR="${BACKUP_HOUR:-3}"

echo "[nightly-daemon] starting — nightly jobs at ${BACKUP_HOUR}:00 (${TZ:-UTC})"

# Catches up anything missed while the stack was down.
sh /usr/local/bin/nightly.sh || echo "[nightly-daemon] first run failed, continuing"

while true; do
  NOW_H="$(date +%-H)"
  NOW_M="$(date +%-M)"
  NOW_S="$(date +%-S)"

  # Seconds remaining until the next BACKUP_HOUR:00:00.
  SECS_NOW=$(( NOW_H * 3600 + NOW_M * 60 + NOW_S ))
  SECS_TARGET=$(( BACKUP_HOUR * 3600 ))
  DELAY=$(( SECS_TARGET - SECS_NOW ))
  [ "$DELAY" -le 0 ] && DELAY=$(( DELAY + 86400 ))

  echo "[nightly-daemon] next run in ${DELAY}s"
  sleep "$DELAY"

  sh /usr/local/bin/nightly.sh || echo "[nightly-daemon] run failed, retrying tomorrow"
done

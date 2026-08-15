#!/bin/sh
# VIXART OS — backup daemon for the `backup` container.
# One backup immediately at start (proof the chain works), then one every night
# at $BACKUP_HOUR, Africa/Casablanca time.
set -eu

BACKUP_HOUR="${BACKUP_HOUR:-3}"

echo "[backup-daemon] starting — nightly backup at ${BACKUP_HOUR}:00 (${TZ:-UTC})"

# Initial backup: does not block the daemon if the database is not ready yet.
sh /usr/local/bin/backup.sh || echo "[backup-daemon] initial backup failed, continuing"

while true; do
  NOW_H="$(date +%-H)"
  NOW_M="$(date +%-M)"
  NOW_S="$(date +%-S)"

  # Seconds remaining until the next BACKUP_HOUR:00:00.
  SECS_NOW=$(( NOW_H * 3600 + NOW_M * 60 + NOW_S ))
  SECS_TARGET=$(( BACKUP_HOUR * 3600 ))
  DELAY=$(( SECS_TARGET - SECS_NOW ))
  [ "$DELAY" -le 0 ] && DELAY=$(( DELAY + 86400 ))

  echo "[backup-daemon] next backup in ${DELAY}s"
  sleep "$DELAY"

  sh /usr/local/bin/backup.sh || echo "[backup-daemon] backup failed, retrying tomorrow"
done

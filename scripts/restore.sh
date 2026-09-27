#!/usr/bin/env bash
# =============================================================================
# VIXART OS — DATABASE RESTORE
#
# ⚠️  DESTRUCTIVE OPERATION ⚠️
# This script OVERWRITES the current database with the contents of a backup.
# Anything entered AFTER the date of the chosen backup will be LOST.
# It asks for written confirmation before doing anything.
#
#   List backups :  bash scripts/restore.sh
#   Restore      :  bash scripts/restore.sh vixart_2026-08-15_030000.sql.gz
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a; # shellcheck disable=SC1091
  source .env; set +a
fi

POSTGRES_DB="${POSTGRES_DB:?POSTGRES_DB missing (.env file)}"
POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER missing (.env file)}"

# THE PRODUCTION OVERLAY, explicitly.
#
# This said plain `docker compose`, which reads docker-compose.yml alone. On the
# server every port binding, the portal's host and half the environment live in
# docker-compose.prod.yml — so a restore run here would stop and start
# containers under a DIFFERENT definition from the one they were created with,
# and compose would recreate them on the base configuration. In the middle of a
# restore is the worst possible moment to discover that.
#
# Overridable, so the same script works on a machine with no overlay.
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}"
if [[ ! -f docker-compose.prod.yml ]]; then
  COMPOSE_FILES="-f docker-compose.yml"
fi
DC="docker compose $COMPOSE_FILES"

# Every process that writes to the database or the uploads volume. The restore
# used to stop `app` only — leaving the CLIENT PORTAL serving and writing (it
# takes support messages and, since the uploads volume was added to it,
# attachments) and the backup daemon free to fire a nightly job into a database
# being overwritten underneath it.
WRITERS="app portal backup"

list_backups() {
  echo "Available backups (volume vixart_backups):"
  echo
  $DC exec -T backup sh -c 'ls -1sh /backups/vixart_*.sql.gz 2>/dev/null || true' </dev/null \
    | sed 's/^/  /'
  echo
  echo "To restore:  bash scripts/restore.sh <file-name>"
}

if [[ $# -lt 1 ]]; then
  list_backups
  exit 0
fi

FILE="$(basename "$1")"
ASSUME_YES="${2:-}"

if ! $DC exec -T backup sh -c "test -f /backups/'$FILE'" </dev/null; then
  echo "ERROR: /backups/$FILE not found." >&2
  echo >&2
  list_backups >&2
  exit 1
fi

cat <<BANNER

  ############################################################
  #                                                          #
  #   WARNING — DESTRUCTIVE RESTORE                          #
  #                                                          #
  #   Target database : $POSTGRES_DB
  #   Backup file     : $FILE
  #                                                          #
  #   The current database will be OVERWRITTEN. Everything   #
  #   entered after this backup will be PERMANENTLY LOST.    #
  #   This action is IRREVERSIBLE.                           #
  #                                                          #
  ############################################################

BANNER

if [[ "$ASSUME_YES" != "--yes" ]]; then
  read -r -p 'Type exactly RESTORE to confirm: ' CONFIRM
  if [[ "$CONFIRM" != "RESTORE" ]]; then
    echo "Cancelled. No data was changed."
    exit 1
  fi
fi

# --- Safety net: back up the current state BEFORE overwriting it. -----------
echo "[restore] backing up the current state first…"
$DC exec -T backup sh /usr/local/bin/backup.sh </dev/null || {
  echo "ERROR: could not back up the current state. Restore aborted." >&2
  exit 1
}

# --- Quiesce every writer, and ABORT if one will not stop --------------------
#
# The old version stopped `app` and ignored the result. A writer that refuses to
# stop is not a detail to shrug at: it means rows are being written into a
# database that is about to be replaced, and the restore would produce a state
# that never existed.
echo "[restore] stopping every writer: $WRITERS"
for svc in $WRITERS; do
  if ! $DC stop "$svc" >/dev/null 2>&1; then
    echo "ERROR: could not stop '$svc'. Restore ABORTED — nothing was changed." >&2
    echo "       Stop it by hand and run this again." >&2
    $DC start app >/dev/null 2>&1 || true
    exit 1
  fi
done

# Confirmed, not assumed. `stop` returning 0 for a service that is still up
# would leave this thinking it had quiesced something it had not.
for svc in $WRITERS; do
  if [[ -n "$($DC ps -q --status running "$svc" 2>/dev/null)" ]]; then
    echo "ERROR: '$svc' is still running after being asked to stop. Restore ABORTED." >&2
    exit 1
  fi
done

echo "[restore] loading $FILE into $POSTGRES_DB…"
$DC exec -T backup sh -c "gunzip -c /backups/'$FILE'" </dev/null \
  | $DC exec -T db psql -v ON_ERROR_STOP=1 --quiet -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# --- The uploaded files ------------------------------------------------------
#
# THE RESTORE USED TO LEAVE THESE BEHIND ENTIRELY.
#
# The dump carries `attachment` rows and not one byte of what they point at, so a
# database-only restore produced a system that believed it had every photograph,
# voice note and signed document, and served a 410 for each of them. The backup
# has always written a matching `vixart_files_<stamp>.tar.gz`; nothing read it.
#
# Paired by timestamp, because a dump from Tuesday with files from Friday is a
# third state that never existed.
FILES_ARCHIVE="${FILE/#vixart_/vixart_files_}"
FILES_ARCHIVE="${FILES_ARCHIVE/%.sql.gz/.tar.gz}"

if $DC exec -T backup sh -c "test -f /backups/'$FILES_ARCHIVE'" </dev/null; then
  echo "[restore] restoring uploaded files from $FILES_ARCHIVE…"
  #
  # EXTRACTED OVER THE TOP, not swapped in. Files uploaded after this backup stay
  # on disk with no row pointing at them — which costs some space and loses
  # nothing. The alternative is deleting bytes we cannot get back in order to
  # tidy up, during the one procedure that exists because something already went
  # wrong.
  #
  # Through a one-off `app` container: the backup service mounts the uploads
  # volume READ-ONLY, deliberately, and a backup process that cannot write to
  # the files it archives is a property worth keeping.
  if $DC exec -T backup sh -c "cat /backups/'$FILES_ARCHIVE'" </dev/null \
     | $DC run --rm --no-deps -T --entrypoint sh app \
         -c 'tar -xzf - -C "${UPLOADS_DIR:-/app/uploads}"'; then
    echo "[restore] files restored."
  else
    echo "[restore] WARNING: the file archive did not extract cleanly." >&2
    echo "          The database is restored. Attachments may be missing — check before use." >&2
  fi
else
  echo "[restore] WARNING: no file archive named $FILES_ARCHIVE." >&2
  echo "          The database is restored and the UPLOADED FILES ARE NOT. Every" >&2
  echo "          attachment row will point at bytes that are not there." >&2
fi

# The dump is taken with --no-privileges: the application role's GRANTs are not
# in the file. Restarting `app` restores them, since its entrypoint replays
# migrations + privileges + conditional seed.
echo "[restore] starting everything again (app restores application privileges)…"
$DC start app >/dev/null
# The portal cannot start until the migrations app is running have finished, or
# it serves a schema that is halfway through changing.
$DC exec -T app sh -c 'exit 0' >/dev/null 2>&1 || sleep 5
for svc in portal backup; do
  $DC start "$svc" >/dev/null 2>&1 || \
    echo "[restore] WARNING: '$svc' did not start — start it by hand." >&2
done
$DC logs --tail 20 app 2>/dev/null || true

echo
echo "[restore] DONE — database $POSTGRES_DB now holds the contents of $FILE."
echo "[restore] The previous state was backed up just before; it is the newest entry in:"
echo "          bash scripts/restore.sh"

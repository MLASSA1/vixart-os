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

DC="docker compose"

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

echo "[restore] stopping the application (avoids writes during the restore)…"
$DC stop app >/dev/null 2>&1 || true

echo "[restore] loading $FILE into $POSTGRES_DB…"
$DC exec -T backup sh -c "gunzip -c /backups/'$FILE'" </dev/null \
  | $DC exec -T db psql -v ON_ERROR_STOP=1 --quiet -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# The dump is taken with --no-privileges: the application role's GRANTs are not
# in the file. Restarting `app` restores them, since its entrypoint replays
# migrations + privileges + conditional seed.
echo "[restore] restarting the application (restores application privileges)…"
$DC start app >/dev/null
$DC logs --tail 20 app 2>/dev/null || true

echo
echo "[restore] DONE — database $POSTGRES_DB now holds the contents of $FILE."
echo "[restore] The previous state was backed up just before; it is the newest entry in:"
echo "          bash scripts/restore.sh"

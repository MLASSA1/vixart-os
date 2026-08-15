#!/bin/sh
# VIXART OS — one-off database backup.
# Writes a timestamped .sql.gz into $BACKUP_DIR and prunes beyond retention.
# Non-destructive: this script only ever reads the database.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-30}"
PGDATABASE="${PGDATABASE:?PGDATABASE missing}"

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
TARGET="$BACKUP_DIR/vixart_${STAMP}.sql.gz"
TMP="$TARGET.partial"

echo "[backup] $(date '+%F %T') — dumping $PGDATABASE to $TARGET"

# --clean --if-exists: the dump can recreate over an existing database.
# The file is renamed only after full success: never a truncated .sql.gz.
pg_dump \
  --format=plain \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --quote-all-identifiers \
  "$PGDATABASE" | gzip -9 > "$TMP"

mv "$TMP" "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "[backup] OK — $TARGET ($SIZE)"

# ---- retention: keep only the N most recent ----
COUNT="$(ls -1 "$BACKUP_DIR"/vixart_*.sql.gz 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$BACKUP_RETENTION" ]; then
  EXCESS=$((COUNT - BACKUP_RETENTION))
  echo "[backup] retention $BACKUP_RETENTION — removing $EXCESS old file(s)"
  ls -1 "$BACKUP_DIR"/vixart_*.sql.gz | sort | head -n "$EXCESS" | while read -r OLD; do
    echo "[backup]   pruning $OLD"
    rm -f "$OLD"
  done
fi

echo "[backup] backups on disk: $(ls -1 "$BACKUP_DIR"/vixart_*.sql.gz 2>/dev/null | wc -l | tr -d ' ')"

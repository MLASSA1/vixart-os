#!/bin/sh
# VIXART OS — one-off database backup.
# Writes a timestamped .sql.gz into $BACKUP_DIR and prunes beyond retention.
# Non-destructive: this script only ever reads the database.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-30}"
PGDATABASE="${PGDATABASE:?PGDATABASE missing}"

mkdir -p "$BACKUP_DIR"

# A dump is the whole business in one file: every client, every invoice, every
# private message, and every password hash. It was being written 644 in a 755
# directory — on this host `/var/lib/docker` is 710 so nothing else could
# actually reach it, but that is a property of the host, not of the backup, and
# the next place these are copied to may not have it. Restrict them here, where
# it travels with the file.
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
umask 077

STAMP="$(date +%Y-%m-%d_%H%M%S)"
TARGET="$BACKUP_DIR/vixart_${STAMP}.sql.gz"
TMP="$TARGET.partial"

echo "[backup] $(date '+%F %T') — dumping $PGDATABASE to $TARGET"

# ---- the dump, and why it is not piped straight into gzip ---------------------
#
# THIS SCRIPT USED TO REPORT SUCCESS WHEN THE DUMP FAILED.
#
# It was `pg_dump ... | gzip -9 > "$TMP"` under `set -eu`, and the exit status of
# a pipeline is the exit status of its LAST command. So pg_dump could fail for
# any reason — credentials, a full disk, the database refusing a connection — and
# gzip would succeed writing the empty stream it received. The file was renamed,
# "OK" was printed, and then retention pruned the oldest backup to make room for
# it. Repeat that for thirty nights and there is nothing left to restore from,
# with a month of green logs behind it.
#
# An empty gzip stream is a VALID gzip stream, so `gzip -t` does not catch it
# either. Reproduced in a code audit with a stub pg_dump exiting 1: exit code 0,
# a published .sql.gz, and 0 bytes inside it.
#
# `set -o pipefail` would fix the status, and this runs under /bin/sh in a
# postgres:16-alpine container where that is busybox ash — supported today, and
# not something a backup should depend on. So: dump to a plain file, check
# pg_dump's OWN status, check the dump is complete, and only then compress and
# publish. Nothing is renamed and no retention runs until all of that holds.
RAW="$TARGET.raw"
rm -f "$RAW" "$TMP"

# --clean --if-exists: the dump can recreate over an existing database.
if ! pg_dump \
  --format=plain \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --quote-all-identifiers \
  "$PGDATABASE" > "$RAW"; then
  rm -f "$RAW"
  echo "[backup] FAILED: pg_dump did not complete. Nothing was published and no old backup was pruned." >&2
  exit 1
fi

# pg_dump writes this as its last line. Its presence is the difference between a
# dump that finished and one that was cut off halfway through a table — which
# would be a perfectly valid, perfectly useless gzip file.
if ! tail -5 "$RAW" | grep -q "PostgreSQL database dump complete"; then
  rm -f "$RAW"
  echo "[backup] FAILED: the dump is truncated — no completion marker. Nothing was published." >&2
  exit 1
fi

if ! gzip -9 < "$RAW" > "$TMP"; then
  rm -f "$RAW" "$TMP"
  echo "[backup] FAILED: could not compress the dump. Nothing was published." >&2
  exit 1
fi
rm -f "$RAW"

# Renamed only after all of the above: never a truncated .sql.gz under the real
# name, and never a pruned retention window paying for one.
mv "$TMP" "$TARGET"
chmod 600 "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "[backup] OK — $TARGET ($SIZE)"

# ---- the uploaded files -----------------------------------------------------
#
# pg_dump covers the database and nothing else. Every attachment lives on the
# uploads volume and PostgreSQL stores only a path to it — so a dump restored
# on its own comes back with rows pointing at bytes that are gone.
#
# A separate archive rather than folded into the dump: a 25 MB file has no
# business inside a SQL text stream, and keeping them apart means the database
# can be restored quickly without waiting for the files.
UPLOADS_DIR="${UPLOADS_DIR:-/uploads}"
if [ -d "$UPLOADS_DIR" ]; then
  FILES_TARGET="$BACKUP_DIR/vixart_files_${STAMP}.tar.gz"
  FILES_TMP="$FILES_TARGET.partial"
  echo "[backup] archiving uploaded files from $UPLOADS_DIR"

  # -C so the archive holds paths relative to the volume root, matching what
  # attachment.stored_path records.
  if tar -czf "$FILES_TMP" -C "$UPLOADS_DIR" . 2>/dev/null; then
    mv "$FILES_TMP" "$FILES_TARGET"
    chmod 600 "$FILES_TARGET"
    FSIZE="$(du -h "$FILES_TARGET" | cut -f1)"
    FCOUNT="$(find "$UPLOADS_DIR" -type f 2>/dev/null | wc -l | tr -d " ")"
    echo "[backup] OK — $FILES_TARGET ($FSIZE, $FCOUNT file(s))"
  else
    rm -f "$FILES_TMP"
    # Loud, not silent. A backup that quietly stops covering half the system is
    # worse than no backup, because it is still trusted.
    echo "[backup] FAILED to archive uploaded files — the dump is fine, the FILES ARE NOT PROTECTED" >&2
  fi
else
  echo "[backup] no $UPLOADS_DIR mounted — files not archived"
fi

# ---- retention: keep only the N most recent, of BOTH kinds ------------------
#
# The file archives are pruned on the same schedule as the dumps. They were not,
# at first: the glob was vixart_*.sql.gz, which does not match a .tar.gz, so the
# archives would have accumulated every night until the disk filled — a backup
# routine that takes the machine down is not a backup routine.
prune() {
  PATTERN="$1"
  LABEL="$2"
  COUNT="$(ls -1 $PATTERN 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$COUNT" -gt "$BACKUP_RETENTION" ]; then
    EXCESS=$((COUNT - BACKUP_RETENTION))
    echo "[backup] retention $BACKUP_RETENTION — removing $EXCESS old $LABEL"
    ls -1 $PATTERN | sort | head -n "$EXCESS" | while read -r OLD; do
      echo "[backup]   pruning $OLD"
      rm -f "$OLD"
    done
  fi
}

prune "$BACKUP_DIR/vixart_[0-9]*.sql.gz" "dump(s)"
prune "$BACKUP_DIR/vixart_files_*.tar.gz" "file archive(s)"

echo "[backup] on disk: $(ls -1 "$BACKUP_DIR"/vixart_[0-9]*.sql.gz 2>/dev/null | wc -l | tr -d ' ') dump(s), $(ls -1 "$BACKUP_DIR"/vixart_files_*.tar.gz 2>/dev/null | wc -l | tr -d ' ') file archive(s)"

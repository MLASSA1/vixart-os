#!/bin/sh
# VIXART OS — sauvegarde ponctuelle de la base.
# Écrit un fichier horodaté .sql.gz dans $BACKUP_DIR et purge au-delà de la rétention.
# Non destructif : ce script ne touche jamais à la base, il ne fait que lire.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-30}"
PGDATABASE="${PGDATABASE:?PGDATABASE manquant}"

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
TARGET="$BACKUP_DIR/vixart_${STAMP}.sql.gz"
TMP="$TARGET.partial"

echo "[backup] $(date '+%F %T') — dump de $PGDATABASE vers $TARGET"

# --clean --if-exists : le dump sait recréer par-dessus une base existante.
# Le fichier n'est renommé qu'après succès complet : jamais de .sql.gz tronqué.
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

# ---- rétention : on ne garde que les N plus récents ----
COUNT="$(ls -1 "$BACKUP_DIR"/vixart_*.sql.gz 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$BACKUP_RETENTION" ]; then
  EXCESS=$((COUNT - BACKUP_RETENTION))
  echo "[backup] rétention $BACKUP_RETENTION — suppression de $EXCESS fichier(s) ancien(s)"
  ls -1 "$BACKUP_DIR"/vixart_*.sql.gz | sort | head -n "$EXCESS" | while read -r OLD; do
    echo "[backup]   purge $OLD"
    rm -f "$OLD"
  done
fi

echo "[backup] sauvegardes présentes : $(ls -1 "$BACKUP_DIR"/vixart_*.sql.gz 2>/dev/null | wc -l | tr -d ' ')"

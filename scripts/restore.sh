#!/usr/bin/env bash
# =============================================================================
# VIXART OS — RESTAURATION DE LA BASE
#
# ⚠️  OPÉRATION DESTRUCTIVE ⚠️
# Ce script ÉCRASE la base de données actuelle par le contenu d'une sauvegarde.
# Tout ce qui a été saisi APRÈS la date de la sauvegarde choisie sera PERDU.
# Il demande une confirmation écrite avant d'agir.
#
#   Lister les sauvegardes :  bash scripts/restore.sh
#   Restaurer              :  bash scripts/restore.sh vixart_2026-08-15_030000.sql.gz
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a; # shellcheck disable=SC1091
  source .env; set +a
fi

POSTGRES_DB="${POSTGRES_DB:?POSTGRES_DB manquant (fichier .env)}"
POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER manquant (fichier .env)}"

DC="docker compose"

list_backups() {
  echo "Sauvegardes disponibles (volume vixart_backups) :"
  echo
  $DC exec -T backup sh -c 'ls -1sh /backups/vixart_*.sql.gz 2>/dev/null || true' </dev/null \
    | sed 's/^/  /'
  echo
  echo "Pour restaurer :  bash scripts/restore.sh <nom-du-fichier>"
}

if [[ $# -lt 1 ]]; then
  list_backups
  exit 0
fi

FILE="$(basename "$1")"
ASSUME_YES="${2:-}"

if ! $DC exec -T backup sh -c "test -f /backups/'$FILE'" </dev/null; then
  echo "ERREUR : /backups/$FILE introuvable." >&2
  echo >&2
  list_backups >&2
  exit 1
fi

cat <<BANNER

  ############################################################
  #                                                          #
  #   ATTENTION — RESTAURATION DESTRUCTIVE                   #
  #                                                          #
  #   Base cible   : $POSTGRES_DB
  #   Sauvegarde   : $FILE
  #                                                          #
  #   La base actuelle sera ÉCRASÉE. Toutes les données      #
  #   saisies après cette sauvegarde seront DÉFINITIVEMENT   #
  #   PERDUES. Cette action est IRRÉVERSIBLE.                #
  #                                                          #
  ############################################################

BANNER

if [[ "$ASSUME_YES" != "--oui" ]]; then
  read -r -p 'Tapez exactement RESTAURER pour confirmer : ' CONFIRM
  if [[ "$CONFIRM" != "RESTAURER" ]]; then
    echo "Annulé. Aucune donnée n'a été modifiée."
    exit 1
  fi
fi

# --- Filet de sécurité : on sauvegarde l'état actuel AVANT de l'écraser. -----
echo "[restore] sauvegarde de sécurité de l'état actuel…"
$DC exec -T backup sh /usr/local/bin/backup.sh </dev/null || {
  echo "ERREUR : impossible de sauvegarder l'état actuel. Restauration annulée." >&2
  exit 1
}

echo "[restore] arrêt de l'application (évite les écritures pendant la restauration)…"
$DC stop app >/dev/null 2>&1 || true

echo "[restore] chargement de $FILE dans $POSTGRES_DB…"
$DC exec -T backup sh -c "gunzip -c /backups/'$FILE'" </dev/null \
  | $DC exec -T db psql -v ON_ERROR_STOP=1 --quiet -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Le dump est produit avec --no-privileges : les GRANT du rôle applicatif ne
# sont pas dans le fichier. Le redémarrage de `app` les rétablit, son entrypoint
# rejouant migrations + privilèges + seed conditionnel.
echo "[restore] redémarrage de l'application (rétablit les privilèges applicatifs)…"
$DC start app >/dev/null
$DC logs --tail 20 app 2>/dev/null || true

echo
echo "[restore] TERMINÉ — la base $POSTGRES_DB contient désormais le contenu de $FILE."
echo "[restore] L'état précédent a été sauvegardé juste avant, il figure en tête de :"
echo "          bash scripts/restore.sh"

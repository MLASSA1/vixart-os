#!/bin/sh
# VIXART OS — démon de sauvegarde du conteneur `backup`.
# Une sauvegarde immédiate au démarrage (preuve que la chaîne fonctionne),
# puis une par nuit à $BACKUP_HOUR, heure d'Afrique/Casablanca.
set -eu

BACKUP_HOUR="${BACKUP_HOUR:-3}"

echo "[backup-daemon] démarrage — sauvegarde quotidienne à ${BACKUP_HOUR}h00 (${TZ:-UTC})"

# Sauvegarde initiale : ne bloque pas le démon si la base n'est pas encore prête.
sh /usr/local/bin/backup.sh || echo "[backup-daemon] sauvegarde initiale échouée, on continue"

while true; do
  NOW_H="$(date +%-H)"
  NOW_M="$(date +%-M)"
  NOW_S="$(date +%-S)"

  # Secondes restantes jusqu'au prochain BACKUP_HOUR:00:00.
  SECS_NOW=$(( NOW_H * 3600 + NOW_M * 60 + NOW_S ))
  SECS_TARGET=$(( BACKUP_HOUR * 3600 ))
  DELAY=$(( SECS_TARGET - SECS_NOW ))
  [ "$DELAY" -le 0 ] && DELAY=$(( DELAY + 86400 ))

  echo "[backup-daemon] prochaine sauvegarde dans ${DELAY}s"
  sleep "$DELAY"

  sh /usr/local/bin/backup.sh || echo "[backup-daemon] échec de la sauvegarde, nouvelle tentative demain"
done

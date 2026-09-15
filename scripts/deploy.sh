#!/usr/bin/env bash
# =============================================================================
# VIXART OS — deploy to the VPS.
#
# Run ON the server, from /opt/clients/vixart-os:
#
#   bash scripts/deploy.sh
#
# Pulls the current main, rebuilds, and restarts. Safe to run repeatedly: the
# database volume is untouched, migrations are journalled so they apply once,
# and the seed skips a database that already has companies in it.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env"

echo "[deploy] $(date '+%F %T') — starting"

if [[ ! -f .env ]]; then
  echo "[deploy] FAILED: no .env. Production secrets are generated on this machine, never copied." >&2
  exit 1
fi

echo "[deploy] pulling"
git fetch --quiet origin
git reset --hard --quiet origin/main
echo "[deploy] at $(git rev-parse --short HEAD) — $(git log -1 --format=%s | cut -c1-60)"

# One core, shared with every other site on this box. A deploy must not make
# the rest of them slow.
echo "[deploy] building (low priority)"
nice -n 15 $COMPOSE build app

echo "[deploy] restarting"
$COMPOSE up -d

# Five minutes, not two. This VPS has one core shared with eight other sites,
# and a cold start runs migrations, the seed check and the Next.js boot before
# it answers. At 120s the script declared a deploy failed that had in fact
# succeeded — a health check that cries wolf teaches you to ignore it.
echo "[deploy] waiting for health (up to 5 min — one core, cold start)"
for i in $(seq 1 150); do
  if curl -sf --max-time 3 "http://127.0.0.1:${APP_PORT:-4000}/api/health" >/dev/null 2>&1; then
    echo "[deploy] healthy: $(curl -s http://127.0.0.1:${APP_PORT:-4000}/api/health)"
    echo "[deploy] done"
    exit 0
  fi
  sleep 2
done

echo "[deploy] FAILED: not healthy after 5 minutes. Recent log:" >&2
$COMPOSE logs --tail 30 app >&2
exit 1

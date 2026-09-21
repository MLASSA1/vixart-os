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

# The backup container runs scripts BIND-MOUNTED from ./scripts. `git reset
# --hard` above replaces those files with new inodes, and a file bind mount
# follows the inode it was given at container creation — so the container goes
# on running the version it started with, however many times this deploys.
#
# It cost an hour: a fix that tightened the permissions on database dumps was
# committed, deployed, and reported as done, while the container kept writing
# them world-readable. Nothing said so; the deploy was green.
echo "[deploy] re-binding the backup container's scripts"
$COMPOSE up -d --force-recreate backup

# The portal runs the SAME image as the application (see docker-compose.yml),
# so a new build only reaches it when its container is replaced. `up -d` alone
# leaves a running container alone when nothing in its definition changed —
# and the image tag pointing somewhere new is not a change compose looks at.
# Without this the portal would keep serving the previous build after every
# deploy, silently.
echo "[deploy] restarting the client portal on the new image"
$COMPOSE up -d --force-recreate portal

# The port the application is actually published on.
#
# `--env-file .env` above is passed to docker compose, which reads it for the
# containers. It puts NOTHING in this shell. So `${APP_PORT:-4000}` fell back
# to 4000 while production publishes 4100, and the health check below polled a
# port nothing was listening on — for five minutes, on every single deploy,
# before declaring a deploy failed that had already succeeded.
#
# That was previously misdiagnosed as slowness and "fixed" by raising the
# timeout from two minutes to five, which bought nothing except a longer wait
# for the same wrong answer.
#
# Read rather than sourced: `.env` holds the database password and the auth
# secret, and sourcing it would put both in this shell where any later `set -x`
# or error trace could print them.
APP_PORT="$(sed -n 's/^APP_PORT=//p' .env | tail -1 | tr -d '\"'\''[:space:]')"
APP_PORT="${APP_PORT:-4000}"
HEALTH="http://127.0.0.1:${APP_PORT}/api/health"

echo "[deploy] waiting for health at ${HEALTH} (up to 5 min — one core, cold start)"
for i in $(seq 1 150); do
  if curl -sf --max-time 3 "$HEALTH" >/dev/null 2>&1; then
    echo "[deploy] healthy after $((i * 2))s: $(curl -s "$HEALTH")"
    echo "[deploy] done"
    exit 0
  fi
  sleep 2
done

# Name the URL that was tried. The last failure said only "not healthy", which
# is what made a wrong port look like a slow boot for weeks.
echo "[deploy] FAILED: ${HEALTH} did not answer within 5 minutes." >&2
echo "[deploy] published ports:" >&2
$COMPOSE ps --format '  {{.Name}}  {{.Ports}}' >&2
echo "[deploy] recent log:" >&2
$COMPOSE logs --tail 30 app >&2
exit 1

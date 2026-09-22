#!/bin/sh
# VIXART OS — application container start-up.
#
# Fixed order, nothing works without it:
#   1. migrations  (schema up to date)
#   2. privileges  (application role, also restored after a database restore)
#   3. seed        (only when the `client` table is empty — idempotent)
#   4. systems     (the public catalogue, idempotent, non-fatal)
#   5. server
#
# Any failing step aborts start-up: better a container that does not start than
# an application wired to an inconsistent schema.
set -e

cd /app

echo "─────────────────────────────────────────────"
echo " VIXART OS — starting"
echo "─────────────────────────────────────────────"

echo "[1/4] migrations…"
node_modules/.bin/tsx scripts/migrate.ts

echo "[2/4] application role and privileges…"
node_modules/.bin/tsx scripts/apply-grants.ts

echo "[3/4] conditional seed…"
node_modules/.bin/tsx seed/vixart.seed.ts

# The twenty-five systems the client portal shows, from seed/systems.json.
# Idempotent — keyed on the website's own slug — so this re-runs every start
# and updates rather than duplicates.
#
# NOT fatal, which is why `set -e` is suspended around it. A catalogue that
# fails to load leaves the portal with one empty page; refusing to start would
# take the whole agency's system down with it, and the two are not remotely
# the same size of problem.
echo "[4/5] client portal catalogue…"
set +e
node_modules/.bin/tsx scripts/import-systems.ts || \
  echo "[systems] WARNING: catalogue not loaded — the portal's 'What we build' will be empty"
set -e

echo "[5/5] Next.js server on port ${PORT:-3000}"
exec node server.js

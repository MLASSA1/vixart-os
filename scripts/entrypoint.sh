#!/bin/sh
# VIXART OS — application container start-up.
#
# Fixed order, nothing works without it:
#   1. migrations  (schema up to date)
#   2. privileges  (application role, also restored after a database restore)
#   3. seed        (only when the `client` table is empty — idempotent)
#   4. server
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

echo "[4/4] Next.js server on port ${PORT:-3000}"
exec node server.js

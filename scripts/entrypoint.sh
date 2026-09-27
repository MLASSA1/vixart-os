#!/bin/sh
# VIXART OS — application container start-up.
#
# Fixed order, nothing works without it:
#   1. migrations  (schema up to date)
#   2. privileges  (application role, also restored after a database restore)
#   3. seed        (only when the `client` table is empty — idempotent)
#   4. systems     (the public catalogue, idempotent, non-fatal)
#   5. the notification mailer, beside the server
#   6. server
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

# --- the notification mailer ---------------------------------------------------
#
# Beside the server, not inside it. It was written as a timer in the Next server
# first; instrumentation is compiled for every runtime this app targets, the
# middleware makes one of those edge, and webpack follows the import graph into
# `pg` looking for `fs` whether or not the code would ever run there. The build
# fails pointing at a dependency nobody wrote.
#
# A second process on a one-core box is a real cost, so it is a small one: a
# query against a partial index once a minute, and nothing at all when there is
# no mail to send. It exits immediately when SMTP is not configured, saying so.
#
# NOT in the portal container: `APP_MODE=portal` holds only the client role's
# connection, which cannot read `notification` at all.
if [ "${APP_MODE:-}" != "portal" ]; then
  echo "[5/6] notification mailer…"
  # --conditions=react-server, and it matters.
  #
  # `src/lib/mailer.ts` and the sweep both begin with `import 'server-only'`,
  # which is a marker package that resolves to a module that THROWS unless the
  # loader asks for the `react-server` export condition — the one Next sets and
  # a bare node does not. Without this flag the daemon died on its first line,
  # in the background, every time the container started: six lines in a log
  # nobody reads, no email ever arriving, and a feature that tests green.
  #
  # The marker is worth keeping. `mailer.ts` holds the mailbox password, and
  # `server-only` is what stops it being imported into a browser bundle by
  # somebody who did not know. So the script joins the condition rather than the
  # module dropping its guard.
  node_modules/.bin/tsx --conditions=react-server scripts/notification-mail.ts --loop &
fi

echo "[6/6] Next.js server on port ${PORT:-3000}"
exec node server.js

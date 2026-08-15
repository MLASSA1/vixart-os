#!/bin/sh
# VIXART OS — démarrage du conteneur applicatif.
#
# Ordre imposé, sans quoi rien ne fonctionne :
#   1. migrations   (schéma à jour)
#   2. privilèges   (rôle applicatif, rétabli aussi après une restauration)
#   3. seed         (uniquement si la table `client` est vide — idempotent)
#   4. serveur
#
# Toute étape qui échoue arrête le démarrage : mieux vaut un conteneur qui ne
# démarre pas qu'une application branchée sur un schéma incohérent.
set -e

cd /app

echo "─────────────────────────────────────────────"
echo " VIXART OS — démarrage"
echo "─────────────────────────────────────────────"

echo "[1/4] migrations…"
node_modules/.bin/tsx scripts/migrate.ts

echo "[2/4] rôle et privilèges applicatifs…"
node_modules/.bin/tsx scripts/apply-grants.ts

echo "[3/4] amorçage conditionnel…"
node_modules/.bin/tsx seed/vixart.seed.ts

echo "[4/4] serveur Next.js sur le port ${PORT:-3000}"
exec node server.js

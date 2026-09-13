#!/usr/bin/env bash
# =============================================================================
# VIXART OS — issue the certificate and switch the site to HTTPS.
#
# Run ON the VPS, AFTER the DNS A record points visionxart.cloud at this
# machine. Let's Encrypt proves control by fetching a file over HTTP from the
# address the name resolves to — so it cannot succeed a moment earlier.
#
#   bash deploy/enable-tls.sh
# =============================================================================
set -euo pipefail

DOMAIN=visionxart.cloud
# -4 is load-bearing: this VPS has IPv6, and without it ifconfig.me answers
# with the v6 address, which never matches the A record and blocks the script
# on DNS that is in fact correct.
IP=$(curl -4 -s --max-time 10 ifconfig.me || echo unknown)

echo "[tls] this machine is ${IP}"
for host in "$DOMAIN" "www.$DOMAIN"; do
  # Ask the authoritative nameserver, not a cache: a resolver may still be
  # holding the old answer long after the record itself is correct.
  NS=$(dig +short NS "$DOMAIN" | head -1)
  RESOLVED=$(dig +short "$host" A @"${NS:-1.1.1.1}" | tail -1)
  echo "[tls] ${host} resolves to ${RESOLVED:-nothing}"
  if [[ "$RESOLVED" != "$IP" ]]; then
    echo "[tls] STOP: ${host} does not point here yet." >&2
    echo "[tls] Add an A record for it → ${IP}, wait for it to propagate, run this again." >&2
    exit 1
  fi
done

# --nginx edits the site in place: adds the TLS block, turns port 80 into a
# redirect, and installs the renewal timer. --redirect makes that explicit.
certbot --nginx \
  -d "$DOMAIN" -d "www.$DOMAIN" \
  --redirect --agree-tos --no-eff-email -m naitamin33@gmail.com --non-interactive

nginx -t && systemctl reload nginx
echo "[tls] certificate installed. Renewal is handled by certbot's systemd timer."
echo "[tls] https://${DOMAIN} → $(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/sign-in")"

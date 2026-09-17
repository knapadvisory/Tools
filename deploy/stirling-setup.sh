#!/usr/bin/env bash
# Deploy Stirling-PDF (self-hosted PDF toolbox) alongside TeamHub on the same VPS.
#
# Runs the official Stirling-PDF container on TeamHub's Docker network as
# "stirling-pdf" and registers a pdf.<domain> route with the shared Caddy —
# the SAME pattern deploy/tools-setup.sh uses for apps.<domain>.
#
# Access is protected by Stirling-PDF's OWN session login (a single, clean
# login — no stacked Caddy basic-auth popup). The initial admin is seeded from
# STIRLING_USER / STIRLING_PASS below. Files are processed on YOUR server and
# never leave it.
#
# Usage, on the VPS:
#   cd /root/Tools            # (or wherever the Tools repo is cloned)
#   git pull
#   bash deploy/stirling-setup.sh
#
# Optional env:
#   STIRLING_DOMAIN    defaults to pdf.knapadvisory.com
#   STIRLING_USER      basic-auth username (default: knap)
#   STIRLING_PASS      basic-auth password (prompted on first run; remembered)
#   STIRLING_IMAGE     defaults to stirlingtools/stirling-pdf:latest-fat
#                      (the "-fat" image bundles LibreOffice + OCR so that
#                       conversions and OCR work; ~2-3 GB. Use ":latest" for a
#                       smaller image without those heavier features.)
set -euo pipefail

CONFIG=/root/knap-stirling.env
_cli_DOMAIN="${STIRLING_DOMAIN:-}"; _cli_USER="${STIRLING_USER:-}"; _cli_PASS="${STIRLING_PASS:-}"; _cli_IMAGE="${STIRLING_IMAGE:-}"
[ -f "$CONFIG" ] && . "$CONFIG"
[ -n "$_cli_DOMAIN" ] && STIRLING_DOMAIN="$_cli_DOMAIN"
[ -n "$_cli_USER" ] && STIRLING_USER="$_cli_USER"
[ -n "$_cli_PASS" ] && STIRLING_PASS="$_cli_PASS"
[ -n "$_cli_IMAGE" ] && STIRLING_IMAGE="$_cli_IMAGE"
STIRLING_DOMAIN="${STIRLING_DOMAIN:-pdf.knapadvisory.com}"
STIRLING_USER="${STIRLING_USER:-knap}"
STIRLING_IMAGE="${STIRLING_IMAGE:-stirlingtools/stirling-pdf:latest-fat}"
if [ -z "${STIRLING_PASS:-}" ]; then
  read -rsp "Set a password for $STIRLING_DOMAIN (user: $STIRLING_USER): " STIRLING_PASS; echo
  [ -z "$STIRLING_PASS" ] && { echo "A password is required (the site would otherwise be public)."; exit 1; }
fi
umask 077
cat > "$CONFIG" <<EOF
STIRLING_DOMAIN="$STIRLING_DOMAIN"
STIRLING_USER="$STIRLING_USER"
STIRLING_PASS="$STIRLING_PASS"
STIRLING_IMAGE="$STIRLING_IMAGE"
EOF

echo "==> Ensuring the teamhub-net network exists..."
docker network create teamhub-net 2>/dev/null || true

echo "==> Pulling $STIRLING_IMAGE (this can take a while for the -fat image)..."
docker pull "$STIRLING_IMAGE"

# Stirling-PDF has its OWN session-based login. We use ONLY that (not Caddy
# basic-auth) so users get a single, clean login — no stacked browser popups.
# The initial admin account is seeded from the credentials below, but that only
# takes effect when the user database is empty. If a previous run already
# created the default admin/stirling account, wipe it once with:
#     RESET_STIRLING_USERS=1 bash deploy/stirling-setup.sh
if [ "${RESET_STIRLING_USERS:-}" = "1" ]; then
  echo "==> RESET_STIRLING_USERS=1 -> wiping the stirling-configs volume so the seeded login applies..."
  docker rm -f stirling-pdf 2>/dev/null || true
  docker volume rm stirling-configs 2>/dev/null || true
fi

echo "==> (Re)starting the stirling-pdf container..."
docker rm -f stirling-pdf 2>/dev/null || true
docker run -d --name stirling-pdf --restart unless-stopped \
  --network teamhub-net \
  -e SECURITY_ENABLELOGIN=true \
  -e SECURITY_INITIALLOGIN_USERNAME="$STIRLING_USER" \
  -e SECURITY_INITIALLOGIN_PASSWORD="$STIRLING_PASS" \
  -e SYSTEM_DEFAULTLOCALE=en-GB \
  -e LANGS=en_GB \
  -v stirling-configs:/configs \
  -v stirling-logs:/logs \
  -v stirling-tessdata:/usr/share/tessdata \
  "$STIRLING_IMAGE"

echo "==> Registering the $STIRLING_DOMAIN route with Caddy (plain reverse-proxy; Stirling handles login)..."
mkdir -p /etc/teamhub/conf.d
ROUTE_FILE=/etc/teamhub/conf.d/stirling.caddy
NEW_ROUTE="$(printf '%s {\n    reverse_proxy stirling-pdf:8080\n}' "$STIRLING_DOMAIN")"

if [ -f "$ROUTE_FILE" ] && [ "$(cat "$ROUTE_FILE" 2>/dev/null)" = "$NEW_ROUTE" ]; then
  echo "    Route already registered and unchanged — leaving Caddy alone."
else
  printf '%s\n' "$NEW_ROUTE" > "$ROUTE_FILE"
  # Never restart Caddy (that drops every live connection) — reload gracefully.
  if docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null; then
    echo "    Caddy reloaded gracefully (zero downtime)."
  else
    echo "    ⚠ Caddy reload failed. Reload by hand: docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
  fi
fi

cat <<EOF

============================================================
Stirling-PDF is deployed (single login — Stirling's own).

  URL:   https://$STIRLING_DOMAIN
  Login: $STIRLING_USER  /  (the password you just set)

If you still see the default admin / stirling login (from an
earlier run), reseed your credentials once:
  RESET_STIRLING_USERS=1 bash deploy/stirling-setup.sh

1) Point an A record for $STIRLING_DOMAIN at this server's IP.
   Caddy fetches the HTTPS certificate on first load (~30s).

2) First load of the -fat image can be slow while it warms up
   LibreOffice / OCR. Give it a minute.

What it adds over the browser PDF tools:
  • PDF -> Word / Excel / PPT (and back)      • OCR scanned PDFs
  • Compress (real size reduction)            • True redaction
  • Watermark, page numbers, metadata, etc.

Handy:
  docker logs stirling-pdf         # app logs
  docker logs caddy                # HTTPS / cert logs
  docker restart stirling-pdf      # restart just this app
Update to the latest Stirling release:
  git pull && bash deploy/stirling-setup.sh
Change the password later: in the Stirling UI -> Account settings
(or reseed a fresh admin with RESET_STIRLING_USERS=1 as above).
============================================================
EOF

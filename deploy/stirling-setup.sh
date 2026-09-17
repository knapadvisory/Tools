#!/usr/bin/env bash
# Deploy Stirling-PDF (self-hosted PDF toolbox) alongside TeamHub on the same VPS.
#
# Runs the official Stirling-PDF container on TeamHub's Docker network as
# "stirling-pdf" and registers a pdf.<domain> route with the shared Caddy —
# the SAME pattern deploy/tools-setup.sh uses for apps.<domain>.
#
# Because a public PDF service on the open internet is a bad idea for a CA firm,
# the route is protected with HTTP basic-auth at the Caddy layer (one shared
# username/password for the whole firm). Files are processed on YOUR server and
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

echo "==> (Re)starting the stirling-pdf container..."
docker rm -f stirling-pdf 2>/dev/null || true
docker run -d --name stirling-pdf --restart unless-stopped \
  --network teamhub-net \
  -e DISABLE_ADDITIONAL_FEATURES=true \
  -e SYSTEM_DEFAULTLOCALE=en-GB \
  -e LANGS=en_GB \
  -v stirling-configs:/configs \
  -v stirling-logs:/logs \
  -v stirling-tessdata:/usr/share/tessdata \
  "$STIRLING_IMAGE"

echo "==> Generating the Caddy basic-auth hash..."
HASH="$(docker exec caddy caddy hash-password --plaintext "$STIRLING_PASS" 2>/dev/null || true)"
if [ -z "$HASH" ]; then
  echo "  ⚠ Could not generate a hash via the caddy container. Is the container named 'caddy'?"; exit 1
fi

echo "==> Registering the $STIRLING_DOMAIN route with Caddy (basic-auth protected)..."
mkdir -p /etc/teamhub/conf.d
ROUTE_FILE=/etc/teamhub/conf.d/stirling.caddy

write_route () {  # $1 = auth directive name (basic_auth | basicauth)
  cat > "$ROUTE_FILE" <<EOF
$STIRLING_DOMAIN {
    $1 {
        $STIRLING_USER $HASH
    }
    reverse_proxy stirling-pdf:8080
}
EOF
}

reload_caddy () { docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null; }

# Caddy v2.8+ uses "basic_auth"; older builds use "basicauth". Try the new name,
# fall back to the old one if the reload rejects it. Never restart Caddy — that
# would drop every live connection (TeamHub, HR, the web console).
write_route "basic_auth"
if reload_caddy; then
  echo "    Caddy reloaded gracefully (basic_auth)."
else
  echo "    basic_auth rejected — trying legacy 'basicauth'..."
  write_route "basicauth"
  if reload_caddy; then
    echo "    Caddy reloaded gracefully (basicauth)."
  else
    echo "    ⚠ Caddy reload failed. Check the route by hand:"
    echo "        cat $ROUTE_FILE"
    echo "        docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
  fi
fi

cat <<EOF

============================================================
Stirling-PDF is deployed.

  URL:   https://$STIRLING_DOMAIN
  Login: $STIRLING_USER  /  (the password you just set)

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
Change the password later:
  STIRLING_PASS='newpass' bash deploy/stirling-setup.sh
============================================================
EOF

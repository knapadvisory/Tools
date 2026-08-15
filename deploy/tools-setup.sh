#!/usr/bin/env bash
# Deploy the KNAP Tools hub (tools.<domain>) alongside TeamHub on the same VPS.
#
# Builds the static-site image, runs it on TeamHub's Docker network as
# "teamhub-tools", and registers a tools.<domain> route with the existing
# Caddy (via the conf.d import that deploy/vps-setup.sh in the TeamHub repo
# sets up) — the same pattern KNAP-HRMS uses for hr.<domain>.
#
# Run this AFTER TeamHub has been deployed at least once with the updated
# vps-setup.sh (which creates the teamhub-net network + Caddy conf.d mount).
#
# Usage, on the VPS:
#   git clone https://github.com/knapadvisory/Tools && cd Tools
#   bash deploy/tools-setup.sh
# Redeploy after changes:
#   git pull && bash deploy/tools-setup.sh
#
# Optional env:
#   TOOLS_DOMAIN     defaults to apps.knapadvisory.com
#   TOOLS_PASSCODE       the shared access key the whole site asks for before
#                        showing anything (remembered in /root/knap-tools.env
#                        for redeploys; prompted for on first run; blank = open)
#   TOOLS_SESSION_HOURS  how long a signed-in session lasts before the
#                        continue-or-close popup (default 3)
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root (Dockerfile lives here)

# Remember settings across redeploys; anything set in the environment wins.
TOOLS_CONFIG=/root/knap-tools.env
_cli_DOMAIN="${TOOLS_DOMAIN:-}"; _cli_PASS="${TOOLS_PASSCODE:-}"; _cli_HRS="${TOOLS_SESSION_HOURS:-}"
[ -f "$TOOLS_CONFIG" ] && . "$TOOLS_CONFIG"
[ -n "$_cli_DOMAIN" ] && TOOLS_DOMAIN="$_cli_DOMAIN"
[ -n "$_cli_PASS" ] && TOOLS_PASSCODE="$_cli_PASS"
[ -n "$_cli_HRS" ] && TOOLS_SESSION_HOURS="$_cli_HRS"
TOOLS_DOMAIN="${TOOLS_DOMAIN:-apps.knapadvisory.com}"
TOOLS_SESSION_HOURS="${TOOLS_SESSION_HOURS:-3}"
if [ -z "${TOOLS_PASSCODE:-}" ]; then
  read -rp "Access key for the site (users must enter this; blank = open): " TOOLS_PASSCODE
fi
TOOLS_PASSCODE="${TOOLS_PASSCODE:-}"
umask 077
cat > "$TOOLS_CONFIG" <<EOF
TOOLS_DOMAIN="$TOOLS_DOMAIN"
TOOLS_PASSCODE="$TOOLS_PASSCODE"
TOOLS_SESSION_HOURS="$TOOLS_SESSION_HOURS"
EOF

docker network create teamhub-net 2>/dev/null || true
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# Reusable run command (single source of truth for both the canary and live).
run_tools() { # $1 = container name, $2 = image tag, extra args...
  local name="$1" image="$2"; shift 2
  docker run -d --name "$name" --network teamhub-net \
    -e TOOLS_PASSCODE="$TOOLS_PASSCODE" \
    -e TOOLS_SESSION_HOURS="$TOOLS_SESSION_HOURS" \
    -e KNAP_DATA=/data \
    "$@" "$image"
}

# ---- Health-gated deploy -------------------------------------------------
# Build the new image as :candidate (NOT :latest), smoke-test it in a throwaway
# canary container bound only to localhost, and promote it to the live container
# ONLY if /healthz returns 200. A broken build therefore can NEVER replace the
# running site — the worst case is "this deploy is skipped, the old one keeps
# serving." The previous good image is kept as :previous for one-step rollback.
echo "==> Building the Tools hub image ($SHA) as :candidate..."
docker build -t knap-tools:candidate .

echo "==> Smoke-testing the new image (canary on 127.0.0.1:8091)..."
docker rm -f teamhub-tools-canary >/dev/null 2>&1 || true
run_tools teamhub-tools-canary knap-tools:candidate -p 127.0.0.1:8091:80 >/dev/null
canary_ok=0
for _ in $(seq 1 20); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8091/healthz 2>/dev/null)" = "200" ]; then canary_ok=1; break; fi
  sleep 1
done
docker rm -f teamhub-tools-canary >/dev/null 2>&1 || true
if [ "$canary_ok" != 1 ]; then
  echo "❌ New image failed the /healthz check — KEEPING the current live deploy (nothing swapped)."
  echo "   Inspect with:  docker logs teamhub-tools-canary   (re-run to reproduce)"
  exit 1
fi
echo "   ✓ Canary healthy."

echo "==> Promoting :candidate → live (keeping the old image as :previous)..."
docker tag knap-tools:latest knap-tools:previous 2>/dev/null || true   # last-good, for rollback
docker tag knap-tools:candidate knap-tools:latest
docker rm -f teamhub-tools 2>/dev/null || true
run_tools teamhub-tools knap-tools:latest --restart unless-stopped -v knap-tools-data:/data >/dev/null
printf '%s\n' "$SHA" > /root/knap-tools-deployed 2>/dev/null || true

echo "==> Registering the $TOOLS_DOMAIN route with Caddy..."
mkdir -p /etc/teamhub/conf.d
cat > /etc/teamhub/conf.d/tools.caddy <<EOF
$TOOLS_DOMAIN {
    reverse_proxy teamhub-tools:80
}
EOF
# Reload Caddy in place (no downtime for TeamHub). Falls back to a restart.
docker exec caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
  || docker restart caddy

cat <<EOF

============================================================
KNAP Tools hub is deployed.

  URL:  https://$TOOLS_DOMAIN

Point an A record for $TOOLS_DOMAIN at this server's IP;
Caddy fetches the HTTPS certificate on first load (~30s).

To update a tool download or the page: edit the repo,
then on the VPS:  git pull && bash deploy/tools-setup.sh

Handy:
  docker logs teamhub-tools   # static-server logs
  docker logs caddy           # HTTPS / certificate logs
============================================================
EOF

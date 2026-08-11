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
# Env (or you'll be prompted / pulled from TeamHub's config):
#   DOMAIN   TeamHub's domain, e.g. teamhub.knapadvisory.com
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root (Dockerfile lives here)

# Non-interactive redeploys: pull the domain from the TeamHub config
# (written by TeamHub's vps-setup.sh). Anything already set in the
# environment still wins, so overrides remain possible.
_cli_DOMAIN="${DOMAIN:-}"
[ -f /root/teamhub.env ] && . /root/teamhub.env
[ -n "$_cli_DOMAIN" ] && DOMAIN="$_cli_DOMAIN"

if [ -z "${DOMAIN:-}" ]; then read -rp "TeamHub domain (e.g. teamhub.knapadvisory.com): " DOMAIN; fi
TOOLS_DOMAIN="tools.$DOMAIN"

echo "==> Building the Tools hub image..."
docker build -t knap-tools:latest .

docker network create teamhub-net 2>/dev/null || true

echo "==> (Re)starting the Tools hub container..."
docker rm -f teamhub-tools 2>/dev/null || true
docker run -d --name teamhub-tools --restart unless-stopped \
  --network teamhub-net \
  knap-tools:latest

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

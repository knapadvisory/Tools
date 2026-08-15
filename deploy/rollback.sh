#!/usr/bin/env bash
# One-step rollback of the KNAP Tools hub to the previous good image.
#
# tools-setup.sh keeps the last-good image tagged `knap-tools:previous` on every
# successful deploy. This swaps the live container back to it in seconds —
# without a rebuild — for when a deploy got through the health check but turns
# out to misbehave. Run on the VPS:  bash deploy/rollback.sh
set -euo pipefail

if ! docker image inspect knap-tools:previous >/dev/null 2>&1; then
  echo "No knap-tools:previous image found — nothing to roll back to."
  echo "(A previous image only exists after at least one successful deploy.)"
  exit 1
fi

# Preserve remembered settings the same way tools-setup.sh does.
TOOLS_CONFIG=/root/knap-tools.env
[ -f "$TOOLS_CONFIG" ] && . "$TOOLS_CONFIG"
TOOLS_SESSION_HOURS="${TOOLS_SESSION_HOURS:-3}"

echo "==> Rolling back: promoting :previous → :latest and restarting the container..."
# Swap latest<->previous so a second rollback returns to where we were.
docker tag knap-tools:latest  knap-tools:rollback-tmp 2>/dev/null || true
docker tag knap-tools:previous knap-tools:latest
docker tag knap-tools:rollback-tmp knap-tools:previous 2>/dev/null || true
docker rmi knap-tools:rollback-tmp >/dev/null 2>&1 || true

docker rm -f teamhub-tools 2>/dev/null || true
docker run -d --name teamhub-tools --restart unless-stopped \
  --network teamhub-net \
  -e TOOLS_PASSCODE="${TOOLS_PASSCODE:-}" \
  -e TOOLS_SESSION_HOURS="$TOOLS_SESSION_HOURS" \
  -e KNAP_DATA=/data \
  -v knap-tools-data:/data \
  knap-tools:latest

echo "==> Rolled back. Verify:"
echo "    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8091/healthz  (if canary up)"
echo "    docker logs --tail=30 teamhub-tools"
echo "    Run rollback.sh again to return to the newer image."

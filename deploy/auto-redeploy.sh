#!/usr/bin/env bash
# Cron worker: when the branch on GitHub has new commits, pull and redeploy.
# Silent when nothing changed. Installed by install-autodeploy.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

exec 9>/tmp/knap-tools-redeploy.lock
flock -n 9 || exit 0            # a previous run is still going — skip

git fetch -q origin
LOCAL=$(git rev-parse @); REMOTE=$(git rev-parse '@{u}')
[ "$LOCAL" = "$REMOTE" ] && exit 0

{
  echo "$(date -Is) new commits found — redeploying…"
  git pull -q
  bash deploy/tools-setup.sh
  echo "$(date -Is) redeployed at $(git rev-parse --short @)"
} >> /var/log/knap-tools-redeploy.log 2>&1

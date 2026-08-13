#!/usr/bin/env bash
# Auto-deploy worker: pull + redeploy whenever the branch on GitHub moves.
# Cron fires this every 2 minutes, but the script itself loops internally,
# checking every ~20s — so a push is live in ~20s, not up to 2 minutes, WITHOUT
# needing the cron interval changed (which would need re-running the installer).
# Self-propagating: because cron git-pulls this file, the faster cadence takes
# effect automatically on the next tick. flock stops two workers overlapping.
set -uo pipefail
cd "$(dirname "$0")/.."

exec 9>/tmp/knap-tools-redeploy.lock
flock -n 9 || exit 0            # a previous worker is still looping — skip

log() { echo "$(date -Is) $1" >> /var/log/knap-tools-redeploy.log 2>&1; }

# Loop for just under the 2-minute cron window, checking every 20s. When the
# window ends the worker exits and the next cron tick starts a fresh one, so
# coverage is continuous.
end=$((SECONDS + 110))
while [ "$SECONDS" -lt "$end" ]; do
  if git fetch -q origin 2>/dev/null; then
    LOCAL=$(git rev-parse @ 2>/dev/null || echo local)
    REMOTE=$(git rev-parse '@{u}' 2>/dev/null || echo remote)
    if [ "$LOCAL" != "$REMOTE" ]; then
      log "new commits found — redeploying…"
      git pull -q && bash deploy/tools-setup.sh >> /var/log/knap-tools-redeploy.log 2>&1
      log "redeployed at $(git rev-parse --short @ 2>/dev/null)"
    fi
  fi
  sleep 20
done

#!/usr/bin/env bash
# One-time: make the VPS redeploy itself whenever new commits land on the
# branch. Cron fires the worker every 2 minutes, and the worker loops
# internally checking every ~20s — so a push is live in ~20s. After this,
# pushing to GitHub is all it takes; nothing to run by hand, ever. The Tally
# connectors then update themselves from the site.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# NOTE: every `|| true` here is load-bearing. On a server with an EMPTY
# crontab, `crontab -l` and the filtering grep both exit non-zero, and under
# set -e that silently killed the script before anything was installed.
EXISTING="$(crontab -l 2>/dev/null | grep -v 'knap.*auto-redeploy\|Tools/deploy/auto-redeploy' || true)"
{ [ -n "$EXISTING" ] && printf '%s\n' "$EXISTING"; \
  echo "*/2 * * * * bash $DIR/deploy/auto-redeploy.sh"; } | crontab -

echo "Installed cron line:"
crontab -l | grep 'auto-redeploy'

touch /var/log/knap-tools-redeploy.log
echo "============================================================"
echo "Auto-redeploy installed — the site now updates itself."
echo "  Checks GitHub every 2 minutes; log: /var/log/knap-tools-redeploy.log"
echo "  Deploy instantly any time:  bash deploy/auto-redeploy.sh"
echo "  Remove with:  crontab -e  (delete the auto-redeploy line)"
echo "============================================================"

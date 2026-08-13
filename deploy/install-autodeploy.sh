#!/usr/bin/env bash
# One-time: make the VPS redeploy itself whenever new commits land on the
# branch — checks every 2 minutes via cron (a git fetch is ~1s and a few KB,
# so frequent checks cost nothing). After this, pushing to GitHub is all it
# takes; the site updates within ~2 minutes and the Tally connectors then
# update themselves from the site. Deploy instantly at any time with:
#   bash deploy/auto-redeploy.sh
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

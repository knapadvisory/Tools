#!/usr/bin/env bash
# One-time: make the VPS redeploy itself whenever new commits land on the
# branch — checks every 10 minutes via cron. After this, pushing to GitHub is
# all it takes; the site updates within ~10 minutes and the Tally connectors
# then update themselves from the site.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"

( crontab -l 2>/dev/null | grep -v 'knap.*auto-redeploy\|Tools/deploy/auto-redeploy'; \
  echo "*/10 * * * * bash $DIR/deploy/auto-redeploy.sh" ) | crontab -

touch /var/log/knap-tools-redeploy.log
echo "============================================================"
echo "Auto-redeploy installed — the site now updates itself."
echo "  Checks GitHub every 10 minutes; log: /var/log/knap-tools-redeploy.log"
echo "  Remove with:  crontab -e  (delete the auto-redeploy line)"
echo "============================================================"

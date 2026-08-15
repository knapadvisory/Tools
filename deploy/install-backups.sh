#!/usr/bin/env bash
# One-time: cron the nightly Tools data-volume backup (deploy/backup.sh) at
# 02:30 server time. Idempotent — re-running just refreshes the cron line.
#   bash deploy/install-backups.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Every `|| true` is load-bearing: on an empty crontab, `crontab -l` and the
# filtering grep both exit non-zero and would kill the script under set -e.
EXISTING="$(crontab -l 2>/dev/null | grep -v 'knap.*backup\.sh\|Tools/deploy/backup' || true)"
{ [ -n "$EXISTING" ] && printf '%s\n' "$EXISTING"; \
  echo "30 2 * * * bash $DIR/deploy/backup.sh >> /var/log/knap-tools-backup.log 2>&1"; } | crontab -

touch /var/log/knap-tools-backup.log
echo "Installed nightly backup cron (02:30):"
crontab -l | grep 'backup'
echo "Backups → ${KNAP_BACKUP_DIR:-/root/knap-backups}  (keeps last ${KNAP_BACKUP_KEEP:-14})."
echo "Run one now:  bash $DIR/deploy/backup.sh"

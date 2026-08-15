#!/usr/bin/env bash
# Restore the KNAP Tools data volume from a backup made by backup.sh.
#
#   bash deploy/restore.sh /root/knap-backups/knap-tools-data-20260101-020000.tar.gz
#
# This REPLACES the current contents of the knap-tools-data volume with the
# archive. It stops the hub container first and restarts it after, so the volume
# isn't being written during the restore.
set -euo pipefail

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: bash deploy/restore.sh <backup.tar.gz>"
  echo "Available backups:"; ls -1t /root/knap-backups/*.tar.gz 2>/dev/null || echo "  (none)"
  exit 1
fi
VOL="knap-tools-data"
ABS="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

echo "==> This will REPLACE the contents of volume $VOL with:"
echo "    $ABS"
read -rp "Type 'restore' to proceed: " ans
[ "$ans" = "restore" ] || { echo "Aborted."; exit 1; }

echo "==> Stopping the hub container so the volume is quiescent..."
docker stop teamhub-tools >/dev/null 2>&1 || true

echo "==> Wiping and restoring the volume..."
docker run --rm \
  -v "${VOL}:/data" \
  -v "$(dirname "$ABS"):/backup:ro" \
  alpine:3 \
  sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; cd /data && tar xzf /backup/$(basename "$ABS") "

echo "==> Restarting the hub..."
docker start teamhub-tools >/dev/null 2>&1 || {
  echo "Container wasn't present — re-run: bash deploy/tools-setup.sh"; }
echo "==> Restore complete. Check:  docker logs --tail=30 teamhub-tools"

#!/usr/bin/env bash
# Nightly backup of the KNAP Tools data volume (knap-tools-data) — the fee-parser
# working files, the GSTR-1 name cache/config, session state, etc. Books never
# leave the client PCs, so this is the server-side state only, but it's still
# worth not losing. Writes a dated tar.gz and keeps the last KEEP days.
#
#   bash deploy/backup.sh                 # one-off backup now
#   (install-backups.sh crons this nightly)
set -euo pipefail

DEST="${KNAP_BACKUP_DIR:-/root/knap-backups}"
KEEP="${KNAP_BACKUP_KEEP:-14}"
VOL="knap-tools-data"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

if ! docker volume inspect "$VOL" >/dev/null 2>&1; then
  echo "Volume $VOL not found — nothing to back up (has the hub been deployed?)."
  exit 1
fi

OUT="$DEST/${VOL}-${STAMP}.tar.gz"
echo "==> Backing up volume $VOL → $OUT"
# Mount the volume read-only in a throwaway alpine and tar it out to $DEST.
docker run --rm \
  -v "${VOL}:/data:ro" \
  -v "${DEST}:/backup" \
  alpine:3 \
  sh -c "cd /data && tar czf /backup/${VOL}-${STAMP}.tar.gz . "

# Retain only the most recent $KEEP archives for this volume.
ls -1t "$DEST/${VOL}-"*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "   pruning old backup: $old"; rm -f "$old"
done

echo "==> Done. Current backups:"
ls -lh "$DEST/${VOL}-"*.tar.gz 2>/dev/null | tail -n "$KEEP"
echo "Restore with:  bash deploy/restore.sh <backup-file>   (or see the header of restore.sh)"

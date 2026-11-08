#!/bin/bash
# Operator-installed scheduler wrapper; no source paths or secret values are logged.
set -euo pipefail
umask 077
exec 9>/run/lock/observatory-vps-collector.lock
flock -n 9 || exit 0
/opt/asafarim-observatory/runtime/backup.sh
runuser -u observatory-upload -- python3 /opt/asafarim-observatory/runtime/prune-snapshots.py \
  --history /var/lib/asafarim-observatory/history \
  --history /var/lib/asafarim-observatory/vps-history \
  --keep 6 --apply

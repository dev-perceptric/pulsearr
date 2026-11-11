#!/usr/bin/env bash
# Rewrites BACKUP_SH in docker-compose.yml from backup.sh (Hostinger's Docker manager can't mount a file).
set -euo pipefail
cd "$(dirname "$0")"
b64=$(base64 -w0 backup.sh)
sed -i "s|^      BACKUP_SH: .*|      BACKUP_SH: ${b64}|" docker-compose.yml
echo "BACKUP_SH updated"

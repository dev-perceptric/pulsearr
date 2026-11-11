#!/usr/bin/env bash
# Rewrites MIGRATE_SH in docker-compose.yml from migrate.sh (Hostinger's Docker manager can't mount a file).
set -euo pipefail
cd "$(dirname "$0")"
b64=$(base64 -w0 migrate.sh)
sed -i "s|^      MIGRATE_SH: .*|      MIGRATE_SH: ${b64}|" docker-compose.yml
echo "MIGRATE_SH updated"

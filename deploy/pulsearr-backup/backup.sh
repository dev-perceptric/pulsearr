#!/usr/bin/env bash
# Nightly backup of the PulseARR database. At BACKUP_AT (UTC) each day it writes pg_dump -Fc to
# /backups/pulsearr-YYYYMMDD-HHMMSS.dump (written to a .part file first, so a half-written dump never looks done),
# deletes local dumps older than KEEP_DAYS, then copies the new dump to Backblaze B2 when B2_KEY_ID, B2_APP_KEY and
# B2_BUCKET are set. B2 keeps them 90 days through the bucket's lifecycle rule, not this script.
# Run once now: docker compose exec backup bash /app/backup.sh now
# Restore: pg_restore --clean --if-exists --no-owner -h db -U supabase_admin -d postgres <file>
set -uo pipefail

AT="${BACKUP_AT:-03:15}"
KEEP="${KEEP_DAYS:-14}"
OUT=/backups

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [ -z "${PGPASSWORD:-}" ]; then
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' /run/sb.env | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
fi
if [ -z "$PGPASSWORD" ]; then log "No POSTGRES_PASSWORD in /run/sb.env"; exit 1; fi
export PGPASSWORD

backup() {
  local name file
  name="pulsearr-$(date -u +%Y%m%d-%H%M%S).dump"
  file="$OUT/$name"
  log "Dumping to $file"
  if ! pg_dump -Fc -f "$file.part"; then
    log "FAILED: pg_dump"; rm -f "$file.part"; return 1
  fi
  mv "$file.part" "$file"
  log "Done: $(du -h "$file" | cut -f1)"
  find "$OUT" -maxdepth 1 -name 'pulsearr-*.dump' -mtime +"$((KEEP - 1))" -print -delete | sed 's/^/Deleted /'

  if [ -n "${B2_KEY_ID:-}" ] && [ -n "${B2_APP_KEY:-}" ] && [ -n "${B2_BUCKET:-}" ]; then
    # rclone reads the B2 remote from these variables, so no config file is needed.
    export RCLONE_CONFIG_B2_TYPE=b2 RCLONE_CONFIG_B2_ACCOUNT="$B2_KEY_ID" RCLONE_CONFIG_B2_KEY="$B2_APP_KEY"
    if rclone copy --retries 5 "$file" "b2:$B2_BUCKET/${B2_PREFIX:-pulsearr}/"; then
      log "Copied to B2: $B2_BUCKET/${B2_PREFIX:-pulsearr}/$name"
    else
      log "FAILED: copy to B2 (the local dump is kept)"; return 1
    fi
  else
    log "B2 not set, kept on the server only"
  fi
}

if [ "${1:-}" = "now" ]; then backup; exit $?; fi

log "Backing up every day at $AT UTC, keeping $KEEP days here"
# One dump when the container starts, so a new or restarted backup proves itself in the logs right away.
if [ "${BACKUP_ON_START:-1}" = "1" ]; then backup || log "First backup failed"; fi
while true; do
  next="$(date -u -d "today $AT" +%s)"
  [ "$next" -le "$(date -u +%s)" ] && next="$(date -u -d "tomorrow $AT" +%s)"
  sleep "$((next - $(date -u +%s)))"
  backup || log "Backup failed; next try tomorrow"
done

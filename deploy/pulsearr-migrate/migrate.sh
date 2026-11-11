#!/usr/bin/env bash
# PulseARR migration runner. Every 2 minutes it checks main; when main has moved (or 30 minutes after a failure) it
# shallow-clones the repo and runs each supabase/migrations/NNN_*.sql file that ops.schema_migrations doesn't list
# yet, in filename order. Each file runs in one transaction together with the row that records it, so a file is
# either fully applied and recorded or not at all. It stops at the first failure, logs the error, and tries again on
# the next push to main or after 30 minutes. Two files with the same number stop it before anything runs.
#
# Env: PGHOST, PGUSER, PGDATABASE (compose), REPO (owner/name), BRANCH, GITHUB_TOKEN (only while the repo is
# private: a fine-grained token with Contents read-only on this one repo). PGPASSWORD comes from /run/sb.env.
# To run a file again: delete its row from ops.schema_migrations, then docker compose restart.
set -uo pipefail

REPO="${REPO:-dev-perceptric/pulsearr}"
BRANCH="${BRANCH:-main}"
DIR="${MIGRATIONS_DIR:-supabase/migrations}"
EVERY="${CHECK_EVERY:-120}"
RETRY_AFTER="${RETRY_AFTER:-1800}"
URL="https://github.com/${REPO}.git"
WORK=/tmp/repo

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [ -z "${PGPASSWORD:-}" ]; then
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' /run/sb.env | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
fi
if [ -z "$PGPASSWORD" ]; then log "No POSTGRES_PASSWORD in /run/sb.env"; exit 1; fi
export PGPASSWORD
# Keep "already exists, skipping" notices out of the logs.
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

# The token goes in a header, so it never lands in a URL, .git/config or the logs.
GIT=(git -c advice.detachedHead=false)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  GIT+=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')")
fi

psql_q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

ensure_table() {
  psql_q <<'SQL'
create schema if not exists ops;
create table if not exists ops.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
SQL
}

# Applies every new file in $WORK/$DIR. Returns 0 when all are applied, 1 on the first failure.
run_new() {
  local sha="$1" f applied dupes
  dupes="$(ls "$WORK/$DIR" | grep -E '^[0-9]{3}_.*\.sql$' | cut -c1-3 | sort | uniq -d)"
  if [ -n "$dupes" ]; then log "Two files share the number(s): $(echo "$dupes" | tr '\n' ' ')- nothing run"; return 1; fi
  applied="$(psql_q -At -c 'select filename from ops.schema_migrations')" || return 1
  for f in $(ls "$WORK/$DIR" | LC_ALL=C sort); do
    case "$f" in [0-9][0-9][0-9]_*.sql) ;; *) continue ;; esac
    if [[ ! "$f" =~ ^[0-9]{3}_[A-Za-z0-9_.-]+\.sql$ ]]; then log "Stopped at $f: only letters, digits, _ . - are allowed in a name"; return 1; fi
    if grep -qxF "$f" <<<"$applied"; then continue; fi
    log "Applying $f"
    if ! psql_q --single-transaction -f "$WORK/$DIR/$f" \
      -c "insert into ops.schema_migrations (filename) values ('$f')" 2>/tmp/err; then
      log "FAILED $f (rolled back):"
      sed 's/^/  /' /tmp/err
      return 1
    fi
    log "Applied $f (${sha:0:12})"
  done
  return 0
}

done_sha=""      # main's commit when every file was applied
failed_sha=""    # main's commit when a file last failed
failed_at=0

log "Watching $REPO $BRANCH every ${EVERY}s"
while true; do
  if ! pg_isready -q; then log "Postgres isn't ready yet"; sleep 10; continue; fi
  sha="$("${GIT[@]}" ls-remote "$URL" "refs/heads/$BRANCH" 2>/tmp/err | cut -f1)"
  if [ -z "$sha" ]; then log "Couldn't read $BRANCH: $(head -n 1 /tmp/err)"; sleep "$EVERY"; continue; fi
  now="$(date +%s)"
  if [ "$sha" = "$done_sha" ]; then sleep "$EVERY"; continue; fi
  if [ "$sha" = "$failed_sha" ] && [ $((now - failed_at)) -lt "$RETRY_AFTER" ]; then sleep "$EVERY"; continue; fi

  rm -rf "$WORK"
  if ! "${GIT[@]}" clone -q --depth 1 --single-branch --branch "$BRANCH" "$URL" "$WORK" 2>/tmp/err; then
    log "Clone failed: $(head -n 1 /tmp/err)"; sleep "$EVERY"; continue
  fi
  sha="$(git -C "$WORK" rev-parse HEAD)"
  if [ ! -d "$WORK/$DIR" ]; then log "No $DIR at ${sha:0:12}"; done_sha="$sha"; sleep "$EVERY"; continue; fi

  if ensure_table && run_new "$sha"; then
    log "Up to date at ${sha:0:12}"
    done_sha="$sha"; failed_sha=""
  else
    log "Stopped at ${sha:0:12}; trying again on the next push or in $((RETRY_AFTER / 60)) minutes"
    failed_sha="$sha"; failed_at="$now"; done_sha=""
  fi
  sleep "$EVERY"
done

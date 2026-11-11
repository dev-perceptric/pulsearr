#!/usr/bin/env bash
# Database tests (npm run test:db). Builds a throwaway database from tests/db/supabase_stub.sql and every file in
# supabase/migrations, in order, twice (each file in one transaction, the way the VPS runner applies them; the
# second pass proves they're safe to run again). Then runs each tests/db/*.sql file in its own copy of that
# database and stops at the first failure, then each tests/db/*.test.ts (worker code against the real database,
# with Stripe mocked) with TEST_DATABASE_URL set to its own copy.
#
#   Local:  bash scripts/test-db.sh
#           Starts a temporary Postgres from PG_BIN (default /usr/lib/postgresql/16/bin) in a temp folder on a free
#           port, and removes it afterwards. As root it runs the server as the `postgres` user (or makes a
#           `pulsearr_pg` user when there's none), because Postgres won't run as root.
#   CI:     DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/postgres bash scripts/test-db.sh
#           Uses that server (a superuser connection); makes and drops its own databases on it.
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
STOP=()
DBS=()

cleanup() {
  set +e
  if [ -n "${ADMIN:-}" ]; then
    for db in "${DBS[@]}"; do "${PSQL[@]}" "$ADMIN" -c "drop database if exists $db" >/dev/null 2>&1; done
  fi
  if [ ${#STOP[@]} -gt 0 ]; then "${STOP[@]}" >/dev/null 2>&1; fi
  if [ -n "${TMP:-}" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

# The URL of another database on the same server: swap the path, keep any ?host=...&port=... query.
url_for() {
  local base="${ADMIN%%\?*}" query=""
  case "$ADMIN" in *\?*) query="?${ADMIN#*\?}" ;; esac
  echo "${base%/*}/$1$query"
}

if [ -n "${DATABASE_URL_TEST:-}" ]; then
  ADMIN="$DATABASE_URL_TEST"
else
  PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
  if [ ! -x "$PG_BIN/initdb" ]; then
    PG_BIN="$(dirname "$(command -v initdb 2>/dev/null || command -v pg_ctl 2>/dev/null || echo /nonexistent/initdb)")"
  fi
  if [ ! -x "$PG_BIN/initdb" ] || [ ! -x "$PG_BIN/pg_ctl" ]; then
    echo "No Postgres found. Install Postgres 16+ or set DATABASE_URL_TEST to a superuser connection." >&2
    exit 1
  fi
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/pulsearr-db.XXXXXX")"
  RUN=()
  if [ "$(id -u)" = 0 ]; then
    PGUSER_OS=postgres
    if ! id "$PGUSER_OS" >/dev/null 2>&1; then
      PGUSER_OS=pulsearr_pg
      id "$PGUSER_OS" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$PGUSER_OS"
    fi
    chown "$PGUSER_OS" "$TMP"
    if command -v runuser >/dev/null 2>&1; then RUN=(runuser -u "$PGUSER_OS" --)
    else RUN=(su -s /bin/sh "$PGUSER_OS" -c '"$0" "$@"'); fi
  fi
  # A free port: the first one from 55432 nothing is listening on.
  PORT=55432
  while (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null || [ -e "/tmp/.s.PGSQL.$PORT" ]; do PORT=$((PORT + 1)); done
  "${RUN[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres -A trust -E UTF8 --no-locale --no-sync >"$TMP/initdb.log" 2>&1 \
    || { cat "$TMP/initdb.log" >&2; exit 1; }
  "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -l "$TMP/server.log" -w -t 30 \
    -o "-p $PORT -k $TMP -c listen_addresses= -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null \
    || { cat "$TMP/server.log" >&2; exit 1; }
  STOP=("${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate -w stop)
  ADMIN="postgresql://postgres@/postgres?host=$TMP&port=$PORT"
fi

run_file() { # url file
  local out
  if ! out="$(PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -1 "$1" -f "$2" 2>&1)"; then
    echo "FAILED: $2" >&2
    echo "$out" >&2
    exit 1
  fi
}

BASE="pulsearr_test_$$"
DBS+=("$BASE")
"${PSQL[@]}" "$ADMIN" -c "create database $BASE" >/dev/null
BASE_URL="$(url_for "$BASE")"
run_file "$BASE_URL" tests/db/supabase_stub.sql

shopt -s nullglob
MIGRATIONS=(supabase/migrations/*.sql)
if [ ${#MIGRATIONS[@]} -eq 0 ]; then echo "No migrations in supabase/migrations" >&2; exit 1; fi
for pass in 1 2; do
  for f in "${MIGRATIONS[@]}"; do run_file "$BASE_URL" "$f"; done
done
echo "migrations: ${#MIGRATIONS[@]} files applied twice"

FAILED=0
for t in tests/db/*.sql; do
  name="$(basename "$t" .sql)"
  [ "$name" = supabase_stub ] && continue
  db="${BASE}_${name}"
  DBS+=("$db")
  "${PSQL[@]}" "$ADMIN" -c "create database $db template $BASE" >/dev/null
  if out="$(PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" "$(url_for "$db")" -f "$t" 2>&1)"; then
    echo "ok   $name"
  else
    echo "FAIL $name" >&2
    echo "$out" >&2
    FAILED=1
    break
  fi
  "${PSQL[@]}" "$ADMIN" -c "drop database if exists $db" >/dev/null
done
if [ $FAILED = 0 ]; then
  for t in tests/db/*.test.ts; do
    name="$(basename "$t" .test.ts)"
    db="${BASE}_ts_${name}"
    DBS+=("$db")
    "${PSQL[@]}" "$ADMIN" -c "create database $db template $BASE" >/dev/null
    if out="$(TEST_DATABASE_URL="$(url_for "$db")" node --test --test-reporter=dot "$t" 2>&1)"; then
      echo "ok   $name (node)"
    else
      echo "FAIL $name (node)" >&2
      echo "$out" >&2
      FAILED=1
      break
    fi
    "${PSQL[@]}" "$ADMIN" -c "drop database if exists $db" >/dev/null
  done
fi
exit $FAILED

#!/usr/bin/env bash
# Runs on the OVH server (149.56.19.140). Pulls the newest PulseARR images (pulsearr-web, the app at app.pulsearr.com,
# and pulsearr-worker, the job worker) and restarts the containers that run them.
# GitHub Actions calls it over SSH after every Build images run on main (.github/workflows/build-images.yml, job
# "deploy"), as "deploy.sh <commit>"; the job then waits until app.pulsearr.com/api/version shows that commit.
# By hand: ./deploy.sh
#
# It finds the containers by image, not by folder: every container whose image is ghcr.io/dev-perceptric/pulsearr-web
# or pulsearr-worker, from whichever compose project started it (pulsearr-web and pulsearr-worker in /docker). Only
# those services are pulled and restarted (--no-deps), so sb-pulsearr and everything else on the server are left
# alone. It never edits a file on the server. When the deploy user can't read a project's compose file or .env (owned
# by root), the restart runs in a throwaway docker CLI container instead, which reads them as root through the Docker
# socket (the docker group already allows it).
#
# Migrations are not run here: the pulsearr-migrate runner applies new files from main every 2 minutes, which is
# before the images are built.
#
# Setup, once, on the server (deploy/README.md, Deploys):
#   1. Put this file in the deploy user's home (/home/ubuntu/pulsearr/deploy.sh), owned by that user so it can
#      replace itself, chmod 755.
#   2. The deploy user is in the docker group.
#   3. In the deploy user's ~/.ssh/authorized_keys, lock the CI key to this script and nothing else:
#        command="/home/ubuntu/pulsearr/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-pulsearr-deploy
set -euo pipefail

REGISTRY=ghcr.io/dev-perceptric
IMAGES="pulsearr-web pulsearr-worker"
# The newest copy of this script is in the web image (Dockerfile), so a change to it needs nothing done on the server.
SCRIPT_IMAGE=$REGISTRY/pulsearr-web:latest
SCRIPT_IN_IMAGE=/app/deploy.sh
LOCK=${TMPDIR:-/tmp}/pulsearr-deploy.lock
# Runs docker compose as root when the deploy user can't read a project's files.
HELPER_IMAGE=docker:27.5.1-cli

log() { echo "deploy: $*"; }
SELF=$(readlink -f "$0")
[ -n "${DEPLOY_TMP:-}" ] && trap 'rm -f "$DEPLOY_TMP"' EXIT

COMMIT=""
for word in ${SSH_ORIGINAL_COMMAND:-} "$@"; do
  [[ "$word" =~ ^[0-9a-f]{40}$ ]] && COMMIT=$word
done

if [ -z "${DEPLOY_TMP:-}" ]; then
  # One deploy at a time. The lock is kept when this hands over to a newer copy (below).
  exec 9>"$LOCK"
  flock -w 600 9 || { log "another deploy is still running" >&2; exit 1; }

  log "deploying ${COMMIT:-the newest images}"
  docker pull -q "$SCRIPT_IMAGE" >/dev/null
  NEW=$(mktemp)
  if docker run --rm --entrypoint cat "$SCRIPT_IMAGE" "$SCRIPT_IN_IMAGE" > "$NEW" 2>/dev/null && head -n 1 "$NEW" | grep -q '^#!' && ! cmp -s "$NEW" "$SELF"; then
    cp "$NEW" "$SELF" 2>/dev/null || true
    log "running the newest deploy script"
    DEPLOY_TMP="$NEW" exec bash "$NEW" "$@"
  fi
  rm -f "$NEW"
fi

# Every container of ours, as "image|image ref|project|working dir|compose files|service".
targets() {
  local ids
  ids=$(docker ps -aq)
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  docker inspect -f '{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Name}}' $ids |
    while IFS='|' read -r image project dir files service oneoff name; do
      ref=${image%@*}
      base=${ref%:*}
      for want in $IMAGES; do
        [ "$base" = "$REGISTRY/$want" ] || continue
        [ "$oneoff" = "True" ] && continue
        if [ -z "$project" ] || [ -z "$service" ]; then
          echo "deploy: ${name#/} runs $want but wasn't started by docker compose. Skipping it." >&2
          continue
        fi
        echo "$want|$ref|$project|$dir|$files|$service"
      done
    done
}

# docker compose in a project's folder: as this user when it can read the project's files, else as root in a
# throwaway container that sees the same paths.
compose() {
  local dir=$1 project=$2 files=$3 file d args=() mounts=()
  shift 3
  IFS=, read -r -a list <<< "$files"
  for file in "${list[@]}"; do args+=(-f "$file"); done
  if (cd "$dir" 2>/dev/null && docker compose -p "$project" "${args[@]}" config -q 2>/dev/null); then
    (cd "$dir" && docker compose -p "$project" "${args[@]}" "$@")
    return
  fi
  mounts=(-v /var/run/docker.sock:/var/run/docker.sock -v "$dir:$dir")
  for file in "${list[@]}"; do
    d=$(dirname "$file")
    case "$d" in "$dir" | "$dir"/*) ;; *) mounts+=(-v "$d:$d:ro") ;; esac
  done
  docker run --rm "${mounts[@]}" -w "$dir" --entrypoint docker "$HELPER_IMAGE" compose -p "$project" "${args[@]}" "$@"
}

declare -A SERVICES=()
declare -A FOUND=()
declare -A REFS=()
while IFS='|' read -r want ref project dir files service; do
  [ -n "$ref" ] || continue
  FOUND[$want]=1
  REFS[$ref]=1
  key="$project|$dir|$files"
  case " ${SERVICES[$key]:-} " in *" $service "*) ;; *) SERVICES[$key]="${SERVICES[$key]:-}${SERVICES[$key]:+ }$service" ;; esac
done < <(targets | sort -u)

if [ "${#SERVICES[@]}" -eq 0 ]; then
  log "no container on this server runs $(for i in $IMAGES; do printf '%s ' "$REGISTRY/$i"; done)" >&2
  exit 1
fi
for want in $IMAGES; do
  [ -n "${FOUND[$want]:-}" ] || log "no container runs $REGISTRY/$want. Nothing to restart for it." >&2
done

FAILED=""
# The images the containers were started from (normally :latest; a container pinned to a commit stays on it).
for ref in "${!REFS[@]}"; do
  log "pulling $ref"
  docker pull -q "$ref" >/dev/null || { log "pulling $ref failed" >&2; FAILED=1; }
done

for key in "${!SERVICES[@]}"; do
  IFS='|' read -r project dir files <<< "$key"
  read -r -a svcs <<< "${SERVICES[$key]}"
  if [ -z "$dir" ] || [ -z "$files" ]; then
    log "project $project has no compose file on record. Not restarting ${svcs[*]}." >&2
    FAILED=1
    continue
  fi
  log "restarting ${svcs[*]} in $project ($dir)"
  if ! compose "$dir" "$project" "$files" up -d --no-deps "${svcs[@]}"; then
    log "restarting ${svcs[*]} in $project failed" >&2
    FAILED=1
  fi
done

# What runs now, to read in the Actions log.
for want in $IMAGES; do
  ids=$(docker ps -q --filter "ancestor=$REGISTRY/$want:latest")
  [ -n "$ids" ] || { log "no running container uses $REGISTRY/$want:latest" >&2; continue; }
  # shellcheck disable=SC2086
  docker inspect -f '{{.Name}} {{.Config.Image}} {{.Image}}' $ids | sed 's|^/|deploy: running |'
done

# Old images pile up with every build. Remove the ones nothing uses.
docker image prune -f >/dev/null || true
if [ -n "$FAILED" ]; then
  log "finished with errors (above)" >&2
  exit 1
fi
log "done"

#!/usr/bin/env bash
# Removes a preview stack completely: containers, network, volumes, database
# and the stack directory.
#
#   destroy.sh <stack-id>

set -euo pipefail

STACK_ID="${1:?usage: destroy.sh <stack-id>}"
PREVIEW_ROOT="${PREVIEW_ROOT:-/opt/preview}"
STACK_DIR="$PREVIEW_ROOT/stacks/$STACK_ID"
PROJECT="prev-$STACK_ID"
LOCK_FILE="/var/lock/preview-$STACK_ID.lock"

exec 9>"$LOCK_FILE"
flock --wait 300 9 || { echo "could not acquire lock for $STACK_ID"; exit 1; }

# Traefik holds an endpoint on the stack's edge network; Compose cannot remove
# a network that still has a container attached.
TRAEFIK_CONTAINER="$(docker ps -q --filter 'label=com.docker.compose.project=traefik' | head -1)"
if [[ -n "$TRAEFIK_CONTAINER" ]]; then
  docker network disconnect -f "prev-${STACK_ID}_edge" "$TRAEFIK_CONTAINER" 2>/dev/null || true
fi

if [[ -f "$STACK_DIR/preview.yml" ]]; then
  echo "==> tearing down $PROJECT"
  # -v drops the named volumes, which is what actually deletes the Postgres data.
  docker compose -p "$PROJECT" --env-file "$STACK_DIR/.env" -f "$STACK_DIR/preview.yml" \
    down --volumes --remove-orphans --timeout 30 || true
fi

# Belt and braces: remove anything still labelled with this project, in case
# the compose file was lost or the stack was created by an older revision.
mapfile -t leftovers < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
if (( ${#leftovers[@]} )); then
  echo "==> removing ${#leftovers[@]} leftover container(s)"
  docker rm -f "${leftovers[@]}" >/dev/null
fi

mapfile -t vols < <(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")
if (( ${#vols[@]} )); then
  echo "==> removing ${#vols[@]} leftover volume(s)"
  docker volume rm -f "${vols[@]}" >/dev/null
fi

mapfile -t nets < <(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")
if (( ${#nets[@]} )); then
  docker network rm "${nets[@]}" >/dev/null 2>&1 || true
fi

rm -rf "$STACK_DIR"
echo "==> $PROJECT destroyed"

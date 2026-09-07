#!/usr/bin/env bash
# Brings one preview stack to the state described by its .env file.
# Runs on the Hetzner server. Invoked over SSH by GitHub Actions.
#
#   deploy.sh <stack-id>
#
# Expects /opt/preview/stacks/<stack-id>/.env and preview.yml to already be in
# place (rsynced by the workflow).

set -euo pipefail

STACK_ID="${1:?usage: deploy.sh <stack-id>}"
PREVIEW_ROOT="${PREVIEW_ROOT:-/opt/preview}"
STACK_DIR="$PREVIEW_ROOT/stacks/$STACK_ID"
PROJECT="prev-$STACK_ID"
LOCK_FILE="/var/lock/preview-$STACK_ID.lock"

[[ -d "$STACK_DIR" ]] || { echo "stack dir $STACK_DIR not found"; exit 1; }

# Serialise everything touching this stack. Two workflows racing on the same
# shared stack (service-a PR and service-b PR both labelled preview:g1) would
# otherwise run `compose up` concurrently and fight over the same containers.
exec 9>"$LOCK_FILE"
if ! flock --wait 300 9; then
  echo "could not acquire lock for $STACK_ID within 300s"
  exit 1
fi

cd "$STACK_DIR"

# The database password is generated on the server, once per stack, and never
# leaves it. Regenerating it on every deploy would break the existing volume,
# so it is persisted next to the stack and appended to the rendered .env.
if [[ ! -f .secret ]]; then
  (umask 077; openssl rand -hex 24 > .secret)
fi
grep -q '^POSTGRES_PASSWORD=' .env || echo "POSTGRES_PASSWORD=$(cat .secret)" >> .env
chmod 600 .env .secret

echo "==> pulling images for $PROJECT"
docker compose -p "$PROJECT" --env-file .env -f preview.yml pull --quiet

echo "==> starting $PROJECT"
# --remove-orphans cleans up containers dropped from the compose file.
# --wait blocks until every healthcheck passes, so a broken preview fails the
# workflow instead of silently serving 502s.
if ! docker compose -p "$PROJECT" --env-file .env -f preview.yml up -d \
      --remove-orphans --wait --wait-timeout 180; then
  echo "==> deploy failed, recent logs:"
  docker compose -p "$PROJECT" --env-file .env -f preview.yml logs --tail 50 || true
  exit 1
fi

# Each stack owns its edge network, so Traefik has to be attached to it before
# it can reach the containers it just discovered.
TRAEFIK_CONTAINER="$(docker ps -q --filter 'label=com.docker.compose.project=traefik' | head -1)"
if [[ -n "$TRAEFIK_CONTAINER" ]]; then
  docker network connect "prev-${STACK_ID}_edge" "$TRAEFIK_CONTAINER" 2>/dev/null \
    && echo "==> attached traefik to prev-${STACK_ID}_edge" \
    || true  # already attached
else
  echo "warning: traefik container not found; stack will not be routable"
fi

# Touch a marker used by reap.sh to find stacks abandoned by a failed cleanup.
date -u +%s > "$STACK_DIR/.last-deploy"

echo "==> $PROJECT is healthy"
docker compose -p "$PROJECT" --env-file .env -f preview.yml ps

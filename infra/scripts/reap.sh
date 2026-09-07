#!/usr/bin/env bash
# Safety net for stacks that outlived their PR: a cancelled cleanup workflow, a
# force-pushed branch, a deleted repo, or a server that was down at close time.
#
#   reap.sh "<space separated list of stack ids that should exist>"
#
# Anything running under a prev-* Compose project that is not in the list gets
# destroyed. Called by the reconcile workflow on a schedule and, as a local
# fallback, by a systemd timer that only enforces the max-age rule.

set -euo pipefail

DESIRED="${1:-}"
PREVIEW_ROOT="${PREVIEW_ROOT:-/opt/preview}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-72}"
# Refuse to wipe everything if the caller passed an empty list by accident
# (for example an API failure in the workflow that produced no stack ids).
ALLOW_EMPTY="${ALLOW_EMPTY:-false}"

if [[ -z "$DESIRED" && "$ALLOW_EMPTY" != "true" ]]; then
  echo "empty desired list and ALLOW_EMPTY!=true; refusing to reap"
  exit 1
fi

declare -A keep=()
for id in $DESIRED; do keep["$id"]=1; done

# Every live preview project on this host.
mapfile -t projects < <(
  docker ps -a --format '{{.Label "com.docker.compose.project"}}' |
    grep -E '^prev-' | sort -u
)

now=$(date -u +%s)

for project in "${projects[@]}"; do
  stack="${project#prev-}"

  if [[ -n "${keep[$stack]:-}" ]]; then
    continue
  fi

  echo "==> $stack has no matching open PR; destroying"
  "$PREVIEW_ROOT/bin/destroy.sh" "$stack" || echo "failed to destroy $stack"
done

# Age-based sweep: even a stack with an open PR is removed once stale, because
# an abandoned PR should not hold server resources indefinitely.
for dir in "$PREVIEW_ROOT"/stacks/*/; do
  [[ -d "$dir" ]] || continue
  stack="$(basename "$dir")"
  marker="$dir/.last-deploy"
  [[ -f "$marker" ]] || continue

  age_hours=$(( (now - $(cat "$marker")) / 3600 ))
  if (( age_hours > MAX_AGE_HOURS )); then
    echo "==> $stack idle for ${age_hours}h (max ${MAX_AGE_HOURS}h); destroying"
    "$PREVIEW_ROOT/bin/destroy.sh" "$stack" || echo "failed to destroy $stack"
  fi
done

# Reclaim disk from images no longer referenced by any running preview.
docker image prune -af --filter "until=48h" >/dev/null 2>&1 || true
docker builder prune -af --filter "until=48h" >/dev/null 2>&1 || true

echo "==> reap complete"
df -h /var/lib/docker | tail -1

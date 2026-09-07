#!/usr/bin/env bash
# Lists stack ids currently present on this host. Used by the systemd timer so
# the local sweep only enforces the age rule and never destroys a stack merely
# because GitHub was unreachable.

set -euo pipefail

docker ps -a --format '{{.Label "com.docker.compose.project"}}' \
  | grep -E '^prev-' \
  | sed 's/^prev-//' \
  | sort -u \
  | tr '\n' ' '

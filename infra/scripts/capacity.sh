#!/usr/bin/env bash
# Prints how loaded the preview host is. Used by the reconcile workflow so
# capacity problems show up in the Actions summary before deploys start failing.

set -euo pipefail

stacks=$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | grep -cE '^prev-' || true)
uniq_stacks=$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | grep -E '^prev-' | sort -u | wc -l)
running=$(docker ps -q | wc -l)
mem_total=$(free -m | awk '/^Mem:/{print $2}')
mem_used=$(free -m | awk '/^Mem:/{print $3}')
disk=$(df -h /var/lib/docker | awk 'NR==2{print $5" of "$2}')
load=$(uptime | sed 's/.*load average: //')

cat <<EOF
### Preview host capacity

| metric | value |
|---|---|
| active stacks | $uniq_stacks |
| preview containers | $stacks |
| running containers | $running |
| memory | ${mem_used}M / ${mem_total}M |
| docker disk | $disk |
| load average | $load |
EOF

# Each stack reserves roughly 1.75 vCPU and 900M of limits.
if (( mem_total > 0 )) && (( mem_used * 100 / mem_total > 85 )); then
  echo
  echo "> [!WARNING]"
  echo "> Memory above 85%. Add a second preview host or lower per-stack limits."
fi

#!/usr/bin/env bash
# Push live run manifests to R2 every minute while an acquire process runs, then
# once more after it exits. Detached; log in data/logs/push-status.loop.log.
set -uo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
mkdir -p data/logs
log="data/logs/push-status.loop.log"
if pgrep -f "push-status-loop-worker" >/dev/null; then echo "push loop already running" >&2; exit 1; fi
(
  nohup bash -c '
    exec -a push-status-loop-worker bash -c "
      while pgrep -f \"pilot.ts acquire\" >/dev/null; do
        pnpm collect:push-status >/dev/null 2>&1 && echo \"\$(date -u +%FT%TZ) pushed\" || echo \"\$(date -u +%FT%TZ) push failed\"
        sleep 60
      done
      pnpm collect:push-status >/dev/null 2>&1
      echo \"\$(date -u +%FT%TZ) final push; acquire finished\"
    "' >>"$log" 2>&1 < /dev/null &
)
sleep 2
pgrep -fl "push-status-loop-worker" >/dev/null && echo "push loop running, log: $log" || { echo "failed to start"; exit 1; }

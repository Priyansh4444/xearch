#!/usr/bin/env bash
# Wait for the detached acquire to exit, retry paused accounts once, then
# normalize, verify, sync to R2, run gate-2 discovery, and push the final status.
# Detached; log in data/logs/<run-id>.finish.log. Never abandons anything.
#
# Usage: apps/collector/scripts/finish-run.sh <run-id>
set -uo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
run_id="${1:?run id required}"
mkdir -p data/logs
log="data/logs/${run_id}.finish.log"

worker() {
  echo "$(date -u +%FT%TZ) waiting for acquire to exit"
  while pgrep -f "pilot.ts acquire" >/dev/null; do sleep 30; done
  status="$(python3 -c "import json,sys; print(json.load(open('data/runs/$run_id/manifest.json'))['acquisition']['status'])" 2>/dev/null || echo missing)"
  echo "$(date -u +%FT%TZ) acquire exited; status=$status"
  if [ "$status" = "in_progress" ]; then
    echo "$(date -u +%FT%TZ) retrying paused/active accounts once"
    node apps/collector/src/cli/pilot.ts acquire --run "$run_id"
    status="$(python3 -c "import json; print(json.load(open('data/runs/$run_id/manifest.json'))['acquisition']['status'])")"
    echo "$(date -u +%FT%TZ) after retry: status=$status"
  fi
  if [ "$status" != "completed" ] && [ "$status" != "partial" ]; then
    echo "$(date -u +%FT%TZ) run is $status; stopping here (needs a human: reopen-account / abandon-account)"
    exit 1
  fi
  echo "$(date -u +%FT%TZ) normalize"
  node apps/collector/src/cli/pilot.ts normalize "$run_id" || { echo "normalize failed"; exit 1; }
  echo "$(date -u +%FT%TZ) verify"
  node apps/collector/src/cli/pilot.ts verify "$run_id" || { echo "verify FAILED"; exit 1; }
  echo "$(date -u +%FT%TZ) sync to R2"
  bash apps/collector/scripts/sync-runs.sh "$run_id" || echo "sync failed (rerun: pnpm collect:sync $run_id)"
  echo "$(date -u +%FT%TZ) discovery with --resolve (min 3 seeds)"
  node apps/collector/src/cli/pilot.ts discover "$run_id" --min-seeds 3 --resolve || echo "discover failed"
  echo "$(date -u +%FT%TZ) final status push"
  bash apps/collector/scripts/push-status.sh >/dev/null 2>&1 || true
  echo "$(date -u +%FT%TZ) done"
}
(
  nohup bash -c "$(declare -f worker); run_id='$run_id'; worker" >>"$log" 2>&1 < /dev/null &
)
sleep 1
echo "finish-run running detached, log: $log"

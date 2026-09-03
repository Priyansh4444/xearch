#!/usr/bin/env bash
# Run `pnpm collect:pilot acquire` detached from the terminal or agent session so
# it survives the session ending. Output goes to data/logs/<run-id>.acquire.log.
#
# Usage:
#   apps/collector/scripts/acquire-detached.sh --run <run-id>          # resume
#   apps/collector/scripts/acquire-detached.sh --label full            # new run
# Any arguments are passed straight to `collect:pilot acquire`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
mkdir -p data/logs

label="run"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--run" ] || [ "$prev" = "--label" ]; then label="$arg"; fi
  prev="$arg"
done
log="data/logs/$(date -u +%Y%m%dT%H%M%SZ)-${label}.acquire.log"

if pgrep -f "pilot.ts acquire" >/dev/null; then
  echo "an acquire process is already running:" >&2
  pgrep -fl "pilot.ts acquire" >&2
  exit 1
fi

# macOS has no setsid; a subshell + nohup + disown reparents the process to launchd
# so it outlives this shell and whatever spawned it.
(
  nohup node apps/collector/src/cli/pilot.ts acquire "$@" >"$log" 2>&1 < /dev/null &
  echo $! > "$log.pid"
  disown
)
pid="$(cat "$log.pid")"
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  echo "acquire exited immediately; see $log" >&2
  tail -20 "$log" >&2
  exit 1
fi
echo "acquire running detached (pid $pid)"
echo "log: $log"
echo "follow: tail -f $log"

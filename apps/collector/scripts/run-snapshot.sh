#!/usr/bin/env bash
# Move an in-progress run between machines through R2.
#
#   run-snapshot.sh push <run-id>   data/runs/<id>/  -> r2:<bucket>/_active/<id>/
#   run-snapshot.sh pull <run-id>   r2:<bucket>/_active/<id>/ -> data/runs/<id>/
#
# Archived runs use sync-runs.sh instead; this is only for a run you intend to
# resume elsewhere. Both directions refuse to touch a run while an acquire
# process is alive, because the checkpoint is rewritten after every page.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

if [ -f .env.r2 ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.r2
  set +a
fi
: "${R2_BUCKET:=xearch-runs}"
for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || { echo "$name is not set. See .env.r2.example." >&2; exit 2; }
done
command -v rclone >/dev/null || { echo "rclone is required (brew install rclone)." >&2; exit 2; }

direction="${1:-}"
run_id="${2:-}"
[ -n "$direction" ] && [ -n "$run_id" ] || { echo "Usage: run-snapshot.sh push|pull <run-id>" >&2; exit 2; }

if pgrep -f "pilot.ts acquire" >/dev/null; then
  echo "an acquire process is running; stop it first so the checkpoint is quiescent:" >&2
  pgrep -fl "pilot.ts acquire" >&2
  exit 1
fi

export RCLONE_S3_PROVIDER=Cloudflare
export RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_S3_ACL=private
export RCLONE_S3_NO_CHECK_BUCKET=true

remote=":s3:${R2_BUCKET}/_active/${run_id}"
local_dir="data/runs/${run_id}"
common=(--transfers 8 --checkers 16 --exclude "*.tmp" --stats 30s --stats-one-line -v)

case "$direction" in
  push)
    [ -d "$local_dir" ] || { echo "no run at $local_dir" >&2; exit 1; }
    # sync (not copy): the checkpoint and manifest must match the local state exactly.
    rclone sync "$local_dir" "$remote" "${common[@]}"
    echo
    echo "snapshot pushed to ${R2_BUCKET}/_active/${run_id}"
    echo "on the other machine: apps/collector/scripts/run-snapshot.sh pull ${run_id}"
    ;;
  pull)
    if [ -d "$local_dir" ]; then
      echo "$local_dir already exists; move it aside before pulling" >&2
      exit 1
    fi
    rclone copy "$remote" "$local_dir" "${common[@]}"
    echo
    echo "restored to $local_dir"
    echo "resume with: apps/collector/scripts/acquire-detached.sh --run ${run_id}"
    ;;
  *)
    echo "Usage: run-snapshot.sh push|pull <run-id>" >&2
    exit 2
    ;;
esac

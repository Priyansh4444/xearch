#!/usr/bin/env bash
# Push the status of in-progress runs (data/runs/<run-id>/manifest.json and
# report.json if present) to the R2 bucket under _live/<run-id>/ so the
# dashboard (apps/dashboard) can show live progress. Only those two small files
# are read, so this is safe to run every minute while acquisition is running.
# Raw pages are never touched here; archived runs are mirrored by sync-runs.sh.
#
# Credentials come from .env.r2 at the repo root (gitignored) or the environment:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, optional R2_BUCKET (default xearch-runs)
#
# Usage: pnpm collect:push-status [run-id] [--dry-run]
#   Loop it while a run is active:  while pnpm collect:push-status; do sleep 60; done
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
  if [ -z "${!name:-}" ]; then
    echo "$name is not set. Put it in .env.r2 (see .env.r2.example) or the environment." >&2
    exit 2
  fi
done
command -v rclone >/dev/null || { echo "rclone is required (brew install rclone)." >&2; exit 2; }

run_id=""
extra=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) extra+=("--dry-run") ;;
    --*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) run_id="$arg" ;;
  esac
done

runs_dir="data/runs"
[ -d "$runs_dir" ] || { echo "nothing to push: $runs_dir does not exist" >&2; exit 1; }
if [ -n "$run_id" ] && [ ! -d "$runs_dir/$run_id" ]; then
  echo "no run at $runs_dir/$run_id" >&2
  exit 1
fi

# The collector rewrites manifest.json (atomic rename) every few seconds while
# acquisition runs, so upload from a point-in-time snapshot; otherwise rclone's
# post-transfer checksum sees a different file and reports corruption.
stage="$(mktemp -d "${TMPDIR:-/tmp}/xearch-push-status.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
count=0
for dir in "$runs_dir"/*/; do
  [ -d "$dir" ] || continue
  id="$(basename "$dir")"
  if [ -n "$run_id" ] && [ "$id" != "$run_id" ]; then continue; fi
  for file in manifest.json report.json; do
    if [ -f "$dir/$file" ]; then
      mkdir -p "$stage/$id"
      cp "$dir/$file" "$stage/$id/$file"
      count=$((count + 1))
    fi
  done
done
if [ "$count" -eq 0 ]; then
  echo "nothing to push: no manifest.json under $runs_dir" >&2
  exit 0
fi

# rclone reads backend options from the environment, so no rclone.conf is needed
# and the secrets never touch a config file.
export RCLONE_S3_PROVIDER=Cloudflare
export RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_S3_ACL=private
export RCLONE_S3_NO_CHECK_BUCKET=true

# copy never deletes remotely; once a run is archived, _live/<run-id>/ stays as
# the last snapshot next to the archived copy.
rclone copy "$stage" ":s3:${R2_BUCKET}/_live" \
  --no-traverse --transfers 4 --checkers 4 --stats-one-line -q "${extra[@]}"
echo "pushed $count file(s) to ${R2_BUCKET}/_live${run_id:+/$run_id}${extra[*]:+ (${extra[*]})}"

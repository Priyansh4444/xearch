#!/usr/bin/env bash
# Mirror archived collection runs (data/old/<run-id>/) to the Cloudflare R2 bucket.
# Raw provider pages are the audit trail, not serving state, so they live in R2
# (docs/COLLECTION.md "Run lifecycle and retention"). Convex only ever sees the
# normalized ingress records.
#
# Credentials come from .env.r2 at the repo root (gitignored) or the environment:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, optional R2_BUCKET (default xearch-runs)
# Create the key pair in the Cloudflare dashboard: R2 > Manage R2 API Tokens >
# Object Read & Write, scoped to the bucket. Never commit it.
#
# Usage: pnpm collect:sync [run-id] [--dry-run]
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

source_dir="data/old"
dest_path="$R2_BUCKET"
if [ -n "$run_id" ]; then
  [ -d "$source_dir/$run_id" ] || { echo "no archived run at $source_dir/$run_id (only archived runs are synced)" >&2; exit 1; }
  source_dir="$source_dir/$run_id"
  dest_path="$dest_path/$run_id"
fi
[ -d "$source_dir" ] || { echo "nothing to sync: $source_dir does not exist" >&2; exit 1; }

# rclone reads backend options from the environment, so no rclone.conf is needed
# and the secrets never touch a config file.
export RCLONE_S3_PROVIDER=Cloudflare
export RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_S3_ACL=private
export RCLONE_S3_NO_CHECK_BUCKET=true

# Archived runs are immutable, so copy (never delete on the remote) and skip files
# whose size and modtime already match.
exec rclone copy "$source_dir" ":s3:${dest_path}" \
  --transfers 8 --checkers 16 \
  --exclude "*.tmp" --stats 30s --stats-one-line -v "${extra[@]}"

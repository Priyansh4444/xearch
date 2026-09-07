#!/usr/bin/env bash
# Read-only pull of an archived collection run from the R2 bucket into data/old/.
# The inverse of sync-runs.sh, downloading only what indexing needs by default:
# manifest.json, report.json, and ingress/records.jsonl — never the ~12k raw pages
# (pass extra rclone include patterns to fetch more, e.g. "raw/44196397/**").
# Every non-manifest file is verified against the manifest's sha256 digests before
# the script reports success; a digest mismatch exits non-zero.
#
# Credentials come from .env.r2 at the repo root (see .env.r2.example) or the
# environment. This script only ever reads from the remote.
#
# Usage: pnpm collect:pull <run-id> [extra-include-pattern ...] [--dry-run]
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
includes=("manifest.json" "report.json" "ingress/records.jsonl")
extra=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) extra+=("--dry-run") ;;
    --*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *)
      if [ -z "$run_id" ]; then run_id="$arg"; else includes+=("$arg"); fi
      ;;
  esac
done
[ -n "$run_id" ] || { echo "Usage: pnpm collect:pull <run-id> [extra-include-pattern ...] [--dry-run]" >&2; exit 2; }

dest="data/old/$run_id"

export RCLONE_S3_PROVIDER=Cloudflare
export RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_S3_NO_CHECK_BUCKET=true

include_flags=()
for pattern in "${includes[@]}"; do
  include_flags+=(--include "$pattern")
done

rclone copy ":s3:${R2_BUCKET}/${run_id}" "$dest" \
  "${include_flags[@]}" \
  --transfers 8 --checkers 16 --stats 30s --stats-one-line -v "${extra[@]}"

for arg in "$@"; do [ "$arg" = "--dry-run" ] && exit 0; done

# Verify every downloaded file (manifest.json is the digest source and is excluded
# from its own archive.files list) against the manifest recorded at archive time.
node - "$dest" <<'VERIFY'
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const dest = process.argv[2];
const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
if (!manifest.archive) {
  console.error(`${manifest.runId}: manifest has no archive digests; refusing to trust the pull`);
  process.exit(1);
}
let checked = 0;
const failures = [];
for (const file of manifest.archive.files) {
  let buffer;
  try {
    buffer = readFileSync(join(dest, file.path));
  } catch {
    continue; // not pulled — partial pulls are the point of this script
  }
  checked += 1;
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== file.sha256 || buffer.byteLength !== file.bytes) failures.push(file.path);
}
if (checked === 0) {
  console.error(`${manifest.runId}: nothing to verify (no pulled file appears in archive.files)`);
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`${manifest.runId}: DIGEST MISMATCH in ${failures.join(", ")} — do not index this pull`);
  process.exit(1);
}
console.log(`${manifest.runId}: verified ${checked} pulled file(s) against manifest digests`);
VERIFY

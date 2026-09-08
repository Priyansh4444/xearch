# Offline PostHog export → Xearch

This adapter reads `xmd_data_captured` schema v1 from exported PostHog JSONL.
Conversion (`stage`) makes **no network calls**. Node 24 is the only converter
dependency. The separate, explicit `ingest` command runs the existing Rust
indexer through Cargo and can send data to Convex.
No database, PostHog project, deployment, or scheduler is provisioned here.

## Prerequisite for ingestion

`master` at `8e88ee3` does not implement the mutation path. The offline adapter
and its tests work on master without the search feature. Before running the Rust
backfill, use an integration that contains `origin/pcstyle/full-search-pipeline`
at `1ce98d1`; that feature is not merged and has no open PR as of 2026-09-07.
This adapter was checked against that commit's `indexer/src/model.rs`, `main.rs`,
`checkpoint.rs`, and `convex_api.rs`. The ingress model is identical on master. Do not use `tail` or
`refresh`: both are unimplemented on the inspected branch. This change does not
alter ingestion, schemas, scoring, or ranking.

## Local workflow

Keep raw exports securely outside source control. Export one event per line,
including `event` and `properties` (an object or JSON-encoded string).
Properties contain the v1 archive envelope and structured `payload.posts`,
`payload.users`, and optional `payload.profile`. Requester identity is ignored.
For several exports, concatenate their JSONL contents before staging, or process
one export at a time after acknowledging the previous batch.

From the repository root:

```sh
node apps/posthog-export/cli.mjs stage /secure/export.jsonl ./data/posthog-state
```

The result prints a unique batch name and its directory. Each directory contains:

- `ingress/posthog-<epochMs>-<uuid>.jsonl`: closed, normalized ingress only.
- `manifest.json`: counts, content hashes, selected IDs and snapshot times.
- `quarantine.jsonl`: line/record locators and fixed reasons; no raw event or actor.

Review quarantine even when staging succeeds. Recover records from the retained
raw export; do not assume a successful conversion means a complete archive.
A zero-record batch retains diagnostics but requires no ingestion or ack.

For a nonempty batch, set `BATCH` to its printed name. **Only when authorized to
send data to the configured Convex deployment**, run the wrapper below from an
integration containing the ingestion prerequisite above:

```sh
BATCH=posthog-<epochMs>-<uuid>
STATE="$PWD/data/posthog-state"
# CONVEX_URL and CONVEX_DEPLOY_KEY must already be set in the environment.
# Cargo must be on PATH. The wrapper derives manifest/lexicon paths from its own location.
node apps/posthog-export/cli.mjs ingest "$STATE" "$BATCH"
```

The wrapper creates a unique `attempts/<uuid>/` inside the batch directory.
Before spawning Cargo, it records the immutable batch hash and exact canonical
checkpoint and quarantine paths in `attempt.json`. It passes only that batch's
closed ingress directory to backfill. It holds the state lock until the child
and its streams finish. Spawn errors, nonzero exit, and signals cannot mark an
attempt successful. No `--limit`, checkpoint override, or quarantine override is
accepted by this wrapper.

After exit zero, the wrapper records process success, then checks the full
checkpoint offset, unchanged batch hash, and the **same bound quarantine path**
before updating the ledger. Rejected lines also advance Rust offsets, so exit
status and checkpoint alone are insufficient. The indexer writes quarantine
files only for rejects; a missing file in this generated directory is normal
for clean ingestion. No fake empty proof file is created.

If acknowledgement fails after process success, rerun only the local check:

```sh
node apps/posthog-export/cli.mjs ack "$STATE" "$BATCH"
```

`ack` accepts no path overrides. Legacy `ack STATE BATCH CHECKPOINT QUARANTINE`
commands fail closed. Manually run indexer commands have no wrapper binding and
cannot be acknowledged by this adapter. The latest attempt must have a recorded
successful process completion. A crash before that record is written requires a
fresh `ingest` attempt even if the server might already have accepted records.

If ingestion fails or quarantines records, preserve the export and attempt
files. Diagnose and fix the cause, then explicitly rerun `ingest` for a fresh
attempt with a new checkpoint and quarantine directory. Previous evidence is
never erased or reused. Replaying accepted records relies on the prerequisite
indexer's idempotent mutation behavior. A repeated `ingest` after ledger ack is
a no-op. Never edit the staged file or erase rejection evidence to force ack.

This is a **local accidental-path-mismatch guard**, not an authenticated server
receipt. It trusts the local Cargo executable on PATH, the indexer implementation,
and unmodified local state. A malicious operator can forge or alter local files;
this wrapper does not protect against that. Keep state private and back it up.
No live ingest was run to validate this wrapper; tests mock the process boundary.

## Deduplication and failure behavior

- `ledger.json` stores only acknowledged content hashes, snapshot times and tweet
  text hashes. Staging does not mark any data record uploaded. Acknowledgement
  also advances snapshot times for unchanged records; zero-delta batches do this
  automatically because their content is already acknowledged. Pending nonempty
  batches retain that metadata in the manifest until ingestion is acknowledged.
- Only one nonempty batch may be pending per state directory. A second stage
  fails with the pending name; finish/retry that batch first. Export input is
  never moved, deleted, or marked consumed.
- Within a batch, keep at most one record per kind/ID, preferring the newest
  captured snapshot. Authors sort before tweets. Across acknowledged batches,
  identical content is suppressed even when `metricsAt` changes. Changed metrics
  or author facts can be staged again. Older observations are suppressed.
- Changed tweet text for an existing ID is quarantined, not silently overwritten.
  Same-timestamp conflicting content is also quarantined. Resolve edits outside
  this adapter using an explicit policy.
- `chunks.json` stores hashed request IDs and observed indices across exports.
  Missing chunks are reported cumulatively. Available valid records can still
  be ingested. No completeness is claimed: producer delivery is best-effort,
  exports may omit windows, and wholly missing requests cannot be detected.
  A crash between batch publication and chunk coverage storage can undercount
  coverage; replay the original export after pending ack to repair it.
- Unique filenames and temp-directory rename publish only closed batches. A
  local exclusive `.lock` serializes stage/ack. After a process crash, verify
  the process stopped before removing its stale lock. Hidden `.tmp` directories
  are unpublished; preserve the input and rerun. Atomic renames protect against
  process interruption, not storage hardware loss; back up state and exports.
- Ledger and chunk maps grow with the corpus and load into memory. This is a
  small offline batch tool, not an unbounded streaming service. Do not share a
  state directory over an unreliable filesystem or use independent ledgers for
  the same destination if cross-batch deduplication matters.

## Mapping and explicit omissions

IDs must be decimal strings (unsafe numeric IDs are not repaired). Tweet dates
accept Fx epoch seconds, epoch milliseconds, or parseable date strings; ingress
uses epoch milliseconds. `metricsAt` comes from `captured_at`. Dates must pass
current indexer sanity gates. Required counts must be safe nonnegative integers.
`reposts` is a fallback for `retweets`; missing counts are **not** invented as
zero. Missing text, author ID, or required metrics quarantines the tweet.

An author needs actual ID, handle, name, follower/following counts, verification
boolean and join date. Incomplete authors are diagnosed and omitted. Their valid
tweets remain eligible: the existing indexer creates its normal stub author.
No fake counts or dates enter authority calculations. A later complete profile
can enrich that stub.

Nested quotes are visited (up to 32 levels) and quote/reply IDs remain edges.
Reply IDs support `replying_to.status` and `replying_to_status[0]`.
`reposted_by` is an actor, not an original-tweet ID: it creates no invented
retweet edge or tweet. Media supports `all`, photos, videos, animated items,
`photo`/`animated_gif` aliases, and variant/format URL fallbacks. Invalid media is
reported rather than silently dropped. Optional bio/avatar/language are copied
only when present. Article bodies, polls, mosaics, view/bookmark counts and
provider-specific extras have no ingress destination and are not indexed.
Media-only/article-only posts without actual tweet text are quarantined.

The converter uses a closed field allowlist. No `distinct_id`, requester ID,
request URL/query, headers, credentials, markdown or response body enters ingress
or sidecars. Content author/tweet IDs and public media/avatar URLs are corpus
fields, not requester identity. Raw exports can still contain requester data:
apply your own retention/access policy to those originals.

The producer's complete capture envelope must stay below 200KB (it currently
uses 190,000 bytes). The importer rejects reconstructed event envelopes at
200,000 bytes, including oversized single records; it never truncates them.
Oversize/depth failures require upstream repair or separate handling. Export
metadata added by PostHog is not counted as part of the capture payload. Separately,
raw export lines above 1,000,000 bytes are streamed into a diagnostic hash without
being buffered or parsed. This bound includes metadata and JSON-string escaping;
re-export oversized lines rather than trimming them. Following lines still run.

## Batch policy and checks

Suggested operator schedule: collect exports until **100 unique valid posts**
are available, or run **daily** for lower volume. Stage a whole closed window,
review the manifest, then backfill it. The daily rule prevents author-only and
low-volume batches from waiting forever. The adapter intentionally does not
install a scheduler, set a PostHog export cursor, or make per-record Convex reads.
Retain overlapping export windows; local content dedup keeps them cheap.

```sh
node --test apps/posthog-export/cli.test.mjs
cargo test --manifest-path indexer/Cargo.toml --test posthog_ingress
```

Fixtures are synthetic, not verified live PostHog exports. `producer-v1-full.jsonl`
is a JSONL copy of x-md’s native Bun-generated archive fixture. The Rust tests
invoke the real converter and deserialize both fixtures with the actual ingress
model, including the producer’s media, metrics, author dates and nested quote.
Node tests cover malformed exports, optional/missing data, identity separation,
provider variants, quotes, size limits, dedup, staging/retry, incomplete chunks,
checkpoint proof, quarantine and tampering. No live export or Convex ingest has
been tested by this change.

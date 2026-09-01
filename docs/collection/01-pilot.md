# Collection pilot: AI/developer Twitter

## Purpose

Prove that Xearch can acquire, resume, archive, normalize, and audit a useful
multi-account corpus before attempting the one-million-tweet goal in
`docs/COLLECTION.md`.

The pilot covers manually selected AI/developer accounts centered on Theo
(`t3dotgg`) and the surrounding developer network. It uses FxTwitter directly. It
does not use the X API, `x-md`, Firecrawl, or X syndication.

## Acceptance criteria

The pilot targets:

1. Each of the ten core accounts contributes 500 accepted, unique tweets authored
   by that resolved account. Collection stops at six months or cursor exhaustion;
   a resulting shortfall is reported explicitly and leaves this target unmet.
2. The merged core corpus contains at least 5,000 globally unique accepted tweets.
   Content discovered through reposts, quotes, and the two bonus timelines may be
   retained, but it does not replace a core account's quota.
3. Every accepted tweet has a complete corresponding author record before that
   author's first tweet in ingress JSONL.
4. Every incomplete candidate remains available in a raw page and has one
   structured rejection entry. No missing value is invented.
5. An interrupted run resumes from its last completed page without losing accepted
   records or emitting duplicate ingress records.
6. Every terminal run is archived under `data/old/<run-id>/` with a finalized,
   internally consistent `manifest.json`.
7. The final pilot report states actual request volume, latency, historical depth,
   duplicate rate, rejection rate, accepted count, and source limitations.

The existing 2% per-author corpus cap does not apply to this deliberately
concentrated pilot. It becomes a gate after later discovery work introduces enough
author diversity.

## Accounts

### Core accounts

| Handle | Accepted authored-tweet target |
|---|---:|
| `t3dotgg` | 500 |
| `ThePrimeagen` | 500 |
| `shadcn` | 500 |
| `rauchg` | 500 |
| `dan_abramov` | 500 |
| `swyx` | 500 |
| `karpathy` | 500 |
| `sama` | 500 |
| `levelsio` | 500 |
| `kentcdodds` | 500 |

### Bonus accounts

- `notpronsh`
- `pcstyle53`

Bonus accounts use the same six-month/cursor limits but have no minimum quota.
Their accepted records are additional to the 5,000-tweet core milestone.

## Requirements

### Architecture

```text
seed handles
  → TypeScript profile resolution
  → TypeScript cursor pagination and raw-page checkpoints
  → TypeScript raw-response validation and normalization
  → ingress/records.jsonl + rejections/records.jsonl
  → finalized manifest and archive under data/old/
```

### TypeScript acquisition responsibilities

- resolve every configured handle and record the returned handle and numeric id
- request timelines through `id:<numeric_user_id>`
- include replies, request up to 100 rows, and never assume the returned page size
- retry transient network failures, HTTP 429, and HTTP 5xx responses with bounded
  exponential backoff
- save each provider page before advancing the atomic checkpoint
- detect null, repeated, and non-advancing bottom cursors
- stop an account at its quota, six months of history, or cursor exhaustion
- retain provider responses without converting missing values to defaults

### TypeScript normalization responsibilities

- consume only retained raw pages; normalization does not make network requests
- validate the FxTwitter fields used by `docs/COLLECTION.md`
- map accepted candidates to the exact `IngressRecord` author/tweet shapes
- normalize handles, timestamps, media, entities, metrics, and relationship ids
- apply the documented repost policy without inventing repost event rows
- deduplicate tweet ids globally across pages, accounts, and resumed runs
- emit each complete author before the first accepted tweet that references it
- reject incomplete candidates with all applicable stable reason codes
- produce deterministic output from the same raw pages and configuration

Normalization must remain replaceable:

- acquisition and normalization communicate only through files in the run layout
- provider-to-ingress mapping is pure and has no filesystem, CLI, or HTTP access
- filesystem traversal, manifest updates, and JSONL writing wrap the pure mapping
- committed provider fixtures define byte-for-byte expected ingress and rejection
  output
- no acquisition code imports normalization implementation details

A future Rust normalizer must be able to consume the same raw pages and
configuration and produce the same JSONL contracts without changing acquisition.

### Initial rejection reason codes

- `invalid_response_shape`
- `missing_tweet_id`
- `empty_text`
- `missing_author`
- `missing_author_id`
- `missing_author_handle`
- `missing_author_created_at`
- `missing_author_counts`
- `missing_author_verification`
- `missing_metric`
- `invalid_created_at`
- `invalid_media`

Reason codes are additive. A rejected candidate records every detected failure and
references its raw file and page rather than copying the source payload.

## Run layout

```text
data/runs/<run-id>/
  manifest.json
  checkpoint.json
  raw/<numeric-user-id>/<page-number>.json
  ingress/records.jsonl
  rejections/records.jsonl
```

Terminal runs move to `data/old/<run-id>/` only after output files and manifest
hashes are finalized. Failed and intentionally abandoned runs are archived too,
with their terminal state and failure recorded in the manifest.

## Non-goals

- one-hop account discovery
- collecting communities outside the approved account list
- scheduled metric refresh for tweets under 48 hours old
- Firecrawl or X syndication fallback
- external-link page enrichment
- direct Convex writes
- implementing the unfinished indexer ingestion pipeline
- proving the one-million-tweet target

## Starting point

The existing TypeScript probe already follows timeline cursors, retries transient
failures, stores raw responses, checkpoints between pages, resumes, and reports
duplicates and required-field gaps. Its NASA trial and observed limitations are in
`docs/COLLECTION.md`.

The probe is evidence, not the finished pilot collector. It still addresses a
handle directly, writes under `data/collection-probes/`, and has no
profile-resolution, normalization, rejection, manifest-finalization, or archive
workflow.

## Todos

### Contract and configuration

- [x] Add a versioned pilot seed configuration containing the ten core and two
      bonus handles, quotas, and six-month limit.
- [ ] Define and test the run-id, manifest, checkpoint, and rejection schemas.
- [ ] Record the FxTwitter API version and OpenAPI specification URL in manifests.

### Acquisition

- [ ] Add profile resolution to the TypeScript client.
- [ ] Persist requested handle, resolved handle, and numeric user id.
- [ ] Change timeline pagination to use `id:<numeric_user_id>`.
- [ ] Move active probe output from `data/collection-probes/` to
      `data/runs/<run-id>/`.
- [ ] Store raw pages under the resolved numeric account id.
- [ ] Make checkpoint writes atomic and verify resume after a forced interruption.
- [ ] Enforce the six-month and authored-tweet quota stop conditions.
- [ ] Detect cursor exhaustion, repetition, and non-advancement explicitly.
- [ ] Finalize terminal acquisition state without deleting partial raw data.

### TypeScript normalization

- [ ] Define the minimal provider response types needed by the documented mappings.
- [ ] Read all retained pages in deterministic account/page order.
- [ ] Normalize complete embedded authors.
- [ ] Normalize tweet text, timestamps, metrics, media, entities, and graph edges.
- [ ] Implement the no-synthetic-repost-row policy.
- [ ] Deduplicate tweet ids globally and record where duplicates were first seen.
- [ ] Emit author records before their first referencing tweet.
- [ ] Write valid ingress JSONL without partially accepted records.
- [ ] Write structured rejection JSONL with stable, additive reason codes.
- [ ] Feed normalization counts and output metadata into `manifest.json`.
- [ ] Keep pure provider mapping independent from HTTP, filesystem, and CLI code.
- [ ] Verify normalization output byte-for-byte against committed golden fixtures
      so a future Rust implementation has an executable compatibility target.

### Archival and integrity

- [ ] Compute byte sizes and SHA-256 digests for retained raw and output files.
- [ ] Finalize counts, date range, cursors, stop reasons, and rejection summaries.
- [ ] Validate manifest totals against ingress and rejection files.
- [ ] Move terminal run directories atomically from `data/runs/` to `data/old/`.
- [ ] Verify an archived run can be normalized again to byte-identical output.

### Tests

- [ ] Commit minimal provider-shaped fixtures for plain, reply, quote, repost,
      image, video, GIF, media-only, and incomplete-author cases.
- [ ] Test profile resolution and numeric-id timeline requests.
- [ ] Test transient retry and `Retry-After` behavior.
- [ ] Test cursor resume, exhaustion, repetition, and six-month termination.
- [ ] Test global deduplication across pages and different seed timelines.
- [ ] Test that empty-text and incomplete-author candidates are preserved and
      rejected without defaults.
- [ ] Test deterministic author-before-tweet JSONL ordering.
- [ ] Test manifest counts and file hashes against the archived files.
- [ ] Run collector output through the real indexer loading workflow when that
      workflow is implemented. This item is blocked on the indexer, not replaced by
      a temporary Serde-only gate.

### Pilot execution

- [ ] Run a small end-to-end collection for `t3dotgg` and inspect every rejection.
- [ ] Resume that run after a deliberate interruption.
- [ ] Run all ten core and two bonus accounts.
- [ ] Confirm 500 accepted authored tweets per core account or document the
      six-month/cursor limitation that prevented it.
- [ ] Confirm at least 5,000 globally unique accepted core tweets.
- [ ] Archive the terminal run with a finalized manifest.
- [ ] Document measured request count, latency, duplicates, rejection reasons,
      historical depth, and accepted corpus shape in this file.

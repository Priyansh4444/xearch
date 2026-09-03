# Collection sources: exact mappings and fallbacks

`docs/INGRESS.md` owns the JSONL contract. This document owns how the collector
gets the public data needed to satisfy it.

The collector calls providers directly. It does not depend on `x-md`.
The current implementation milestone is [the collection pilot](collection/01-pilot.md).

## 1. Decision

1. FxTwitter is the primary source for posts, profiles, timelines, search, metrics,
   relationships, and media.
2. X syndication is a partial fallback. It can recover a post, but it cannot fill
   every required metric or author field.
3. Firecrawl is a last-resort text recovery path for X URLs. It never supplies
   missing counts, ids, relationships, or media by inference.
4. Repost wrappers are not ingested. We ingest the original post once, use its
   repost count, and leave `retweetOfTweetId` null.
5. Missing data stays missing. The collector never turns an unavailable count into
   zero just to pass validation.
6. TypeScript owns collection, split into acquisition and normalization stages.
   Acquisition owns HTTP, retries, cursors, checkpoints, and raw-page archival.
   Normalization owns provider validation, deduplication, ingress JSONL, and
   structured rejections.

This is a hackathon collector: small, focused, and best-effort. Acquisition is
checkpointed after every page so interrupted runs can resume without losing or
duplicating work. Normalization is deterministic over the archived raw pages.

### Final goal

The final collector should build a dense, useful corpus rather than maximize an
unstructured tweet count:

- collect at least one million accepted, globally unique tweets once measured
  source throughput and historical depth show that target is feasible
- concentrate the corpus across 3–5 deliberately selected communities so search
  queries and interaction graphs have useful depth
- include replies, quotes, media, and months of history instead of collecting only
  isolated recent posts
- keep every source request reproducible through raw-page retention, manifests,
  stable account ids, and content hashes
- produce only records that satisfy `docs/INGRESS.md`; preserve and report every
  rejected candidate without fabricating missing values

Scale is staged. The first gate is the 62-account AI/developer pilot in
[collection/01-pilot.md](collection/01-pilot.md), not one million tweets. Later
gates must be justified by observed rows per request, latency, repeated-row rate,
rejection rate, cursor depth, and provider failures. One-hop graph discovery
(gate 2) starts only after the pilot's interaction and per-author-share
measurements exist; it is documented in the pilot file and not implemented.

### Account identity

Configuration uses human-readable handles plus a pinned numeric `expectedUserId`.
At the beginning of a run, acquisition resolves each handle through
`GET /2/profile/{handle}` and records:

- requested handle
- provider-returned handle
- numeric user id

Timeline requests use `id:<numeric_user_id>`, which is stable across handle
changes. A returned id that differs from the pinned id pauses that account with
`identity_mismatch`; the run never merges two identities or collects the wrong
person because a handle resolved "successfully". A legitimate rename is an explicit
config change that keeps the pinned id.

### Run lifecycle and retention

Active and resumable runs live under `data/runs/<run-id>/`. Terminal runs
(`completed`, `partial`, `abandoned`, `failed`) are moved as complete directories
to `data/old/<run-id>/` once their outputs and digests are finalized. Both roots
are ignored by Git. Archived means immutable and finalized, not successful; the
manifest's `acceptance` block says whether the run met the pilot criteria.

Each run contains:

```text
data/runs/<run-id>/
  config.json                  exact configuration snapshot used by the run
  checkpoint.json              acquisition state, atomic, single source of truth
  manifest.json                projection of the checkpoint + normalization + archive
  raw/<numeric-user-id>/
    profile.json, profile.meta.json
    <page-number>.json         unchanged provider body
    <page-number>.meta.json    receivedAt, request, HTTP status, attempts, latency,
                               row count, output cursor
    <page-number>.error.json   retained provider failure, when one paused the account
  raw/_unresolved/<handle>/    profiles that failed the identity check
  ingress/records.jsonl
  rejections/records.jsonl
  duplicates/records.jsonl
  skips/records.jsonl
  report.json
```

`manifest.json` records:

- run id, acquisition status, source, API version, and specification URL
- collector Git revision, dirty flag, and configuration hash
- creation time, history cutoff, coverage floor
- per account: requested and resolved handle, numeric id, cohort, state, pages,
  requests, retries, rows, authored date range, stop or pause reason, abandon reason
- normalization counts by candidate origin and rejection reason, duplicate,
  refresh, skip, tombstone, and author counts, per-account coverage, per-author share
- every retained file's relative path, byte size, and SHA-256 digest
- acceptance result with reasons

Archived runs are mirrored to the Cloudflare R2 bucket `xearch-runs` with
`pnpm collect:sync [run-id]` (`apps/collector/scripts/sync-runs.sh`, rclone over
the S3 API, credentials in the gitignored `.env.r2`). R2 holds raw pages and
outputs because they are the audit trail, not serving state; Convex only ever
receives normalized ingress records through the indexer. The bucket layout mirrors
`data/old/<run-id>/` exactly, so the manifest digests verify the mirror too.

Raw responses are the audit trail. `metricsAt` for every candidate is the
`receivedAt` of its page sidecar, so re-normalizing an archived run reproduces the
output byte for byte; `pnpm collect:pilot verify <run-id>` checks exactly that.
Rejection records reference a raw file, page, result index, candidate origin,
parent id, and candidate id when available, plus all applicable reason codes; they
do not duplicate the provider payload.

## 2. Tested sources

Tests ran on 2026-08-31 from the development machine. Latency is one observed
round trip, not an SLA.

The source contract is the [FxTwitter API documentation](https://docs.fxembed.com/api/twitter)
and its [OpenAPI 3.0 document](https://api.fxtwitter.com/2/openapi.json). In
particular, `GET /2/profile/{handle}/statuses` documents:

- `count` from 1–100
- pagination with the preceding response's `cursor.bottom`
- optional replies through `with_replies`
- `204 No Content` when a first-page `since` query has no newer posts

The OpenAPI schema is a baseline, not proof that every upstream response contains
every ingress field. For example, `APIUser.verification` is documented but is not
in the schema's required list, while our author ingress requires `verified`.

| Source | Request | Result | Latency |
|---|---|---|---:|
| FxTwitter | `GET /2/status/1546621144358391808` | Full image post, author, metrics, and media | 339 ms |
| FxTwitter | `GET /2/status/1546648714311131136` | Full reply and parent post id | 262 ms |
| FxTwitter | `GET /2/status/2094133014330565026` | Full quote and quoted post id | 319 ms |
| FxTwitter | `GET /2/status/2094033367767339277` | Direct video URL and variants | 264 ms |
| FxTwitter | `GET /2/profile/NASA` | Numeric id, counts, joined date, and verification | 270 ms |
| FxTwitter | `GET /2/profile/NASA/statuses?count=20&with_replies=true` | Timeline with originals, replies, quotes, and repost context | 1.29 s |
| FxTwitter | `GET /2/search?q=gif&feed=media&count=20` | GIF results with direct media data | 2.12 s |
| X syndication | `GET /tweet-result?id=1546621144358391808&lang=en&token=0` | Text, ids, time, likes, replies, language, and image | 274 ms |
| X syndication | `GET /tweet-result?id=1546648714311131136&lang=en&token=0` | Reply parent id recovered | 265 ms |
| Firecrawl | Public X post/profile scrape | Text was usable; structured data was incomplete | 6–10 s |
| Firecrawl | External NASA page | 45–53k characters of noisy Markdown | 1.48–1.51 s |

FxTwitter endpoints use `https://api.fxtwitter.com`. The syndication endpoint uses
`https://cdn.syndication.twimg.com`. Neither requires collector credentials.

### Timeline reliability probe

Run the resumable probe before depending on a profile timeline:

```sh
pnpm collect:probe NASA --pages 10 --count 100 \
  --out data/collection-probes/nasa
```

It writes exact provider responses under `raw/`, an atomic `checkpoint.json`, and
a `report.json`. Running the same command and output directory again resumes from
the saved bottom cursor. The checkpoint rejects changes to the handle, source URL,
page size, or reply mode so incompatible runs cannot be combined accidentally.
Transient network errors, HTTP 429s, and HTTP 5xx responses use bounded retries.

A 20-page NASA run on 2026-09-01 observed:

| Measurement | Result |
|---|---:|
| Returned rows | 457 |
| Unique tweet ids | 444 |
| Duplicate rows across page boundaries | 13 (2.84%) |
| Rows per page despite `count=100` | 10–29 (mean 22.9) |
| Request latency | 906–1,947 ms (mean 1,176 ms) |
| Cursor behavior | 20 distinct advancing bottom cursors |
| Retry count | None needed |
| Time depth reached | 2026-05-26 through 2026-09-01 |
| Required-field gaps | One media-only post had empty `text` |

The run proves cursor pagination and checkpoint resume over this sample. It does
not establish a rate limit, maximum historical depth, availability SLA, or that a
million-tweet corpus is feasible. `count=100` is only a requested page size; the
upstream timeline returned far fewer rows. A separate `count=1` request still
returned 22 rows, so callers must not depend on FxTwitter honoring an exact page
size. Empty-text media posts cannot satisfy the current ingress quality gate and
must be skipped or handled by an explicit contract change, not silently invented.

## 3. Tweet mapping

| Ingress / Convex field | FxTwitter source | Rule |
|---|---|---|
| `id` / `tweetId` | `status.id` | Keep as a string. This is the dedupe key. |
| `authorId` | `status.author.id` | Keep the numeric id as a string. |
| `authorHandle` | `status.author.screen_name` | Lowercase and remove a leading `@`. |
| `text` | `status.text` | Use the resolved display text, not `raw_text.text`, which may contain encoded entities and `t.co` links. |
| `createdAt` | `status.created_timestamp` | Multiply Unix seconds by 1,000. Parse `created_at` only as a fallback. |
| `metrics.likes` / `likeCount` | `status.likes` | Required. |
| `metrics.retweets` / `retweetCount` | `status.reposts` | Required. FxTwitter calls reposts `reposts`. |
| `metrics.replies` / `replyCount` | `status.replies` | Required. |
| `metrics.quotes` / `quoteCount` | `status.quotes` | Required. |
| `metricsAt` | Collector clock | Set immediately after the response arrives. |
| `quotedTweetId` | `status.quote.id` | Null when there is no quote. Keep dangling target ids. |
| `retweetOfTweetId` | — | Always null under the repost policy in §5. |
| `inReplyToTweetId` | `status.replying_to.status` | Fall back to the first `replying_to_status` entry if present. |
| `lang` | `status.lang` | Omit only when the provider omits it. |
| `media[].type` / `mediaType` | `status.media.all[].type` | Map `photo` → `image`, `video` → `video`, `gif` → `gif`. No items → `none`. |
| `media[].url` / `mediaUrls` | `status.media.all[].url` | Deduplicate. Keep one primary URL per item, not every video bitrate. |
| `entities.hashtags` | `status.raw_text.facets[type=hashtag]` | Store the original tag without `#`. Derive from text if facets are absent. |
| `entities.mentions` | `status.raw_text.facets[type=mention]` | Store the original handle without `@`. |
| `entities.urls` | `status.raw_text.facets[type=url].replacement` | Prefer the expanded replacement over the `t.co` original. |
| `hasLink` | URL facets, then local tokenizer | Media-only facets do not count as external links. |

For the schema's single `mediaType`, use this precedence if a provider ever returns
mixed items: `video`, then `gif`, then `image`, then `none`.

Direct media URLs are upstream CDN URLs. They may change or expire. A failed media
fetch does not invalidate the tweet record; it only skips that media embedding.

## 4. Author mapping

The author embedded in a FxTwitter post is sufficient for normal ingestion. Use
`GET /2/profile/{handle}` when discovering an author without a post or refreshing
profile counts.

| Ingress / Convex field | FxTwitter source | Rule |
|---|---|---|
| `id` / `authorId` | `author.id` | Keep as a string. |
| `handle` | `author.screen_name` | Lowercase and remove a leading `@`. |
| `displayName` | `author.name` | Preserve Unicode. |
| `followerCount` | `author.followers` | Snapshot value. |
| `followingCount` | `author.following` | Snapshot value. |
| `verified` | `author.verification.verified` | Store the boolean. The current schema does not retain verification type. |
| `createdAt` | `author.joined` | Parse to epoch milliseconds. This is required by ingress but is not stored in Convex. |
| `bio` | `author.description` | Optional ingress enrichment. |
| `avatarUrl` | `author.avatar_url` | Optional ingress enrichment. |
| `nameTokens` | Local tokenizer | Never take tokenization from a provider. |
| `authority` | Local indexer | Initialize from follower count, then refresh from the collected graph. |
| `isStub` | Collector/indexer state | False for a real author object; true only for a synthesized orphan. |

Follower and following counts can move between two requests. That is expected.
Their collection time is the enclosing ingest run's timestamp.

## 5. Repost policy

FxTwitter represents a reposted timeline item as:

```text
originalTweetId = status.id
reposterAuthorId = status.reposted_by.id
```

It does not expose a separate repost event id or repost timestamp. A synthetic
tweet row would need both, so we do not create one.

When `status.reposted_by` is present:

1. Normalize and ingest `status` as its original author's tweet, deduped by
   `status.id`.
2. Do not emit a second tweet for the reposter.
3. Set the required ingress key `retweetOfTweetId` to null.
4. Use `status.reposts` as the original tweet's `retweetCount`.

The accepted loss is per-reposter graph edges. Quote, reply, and mention edges still
feed authority and boost propagation. If repost edges later prove useful, add a
separate relation table keyed by `(originalTweetId, reposterAuthorId)` instead of
inventing tweet rows.

## 6. Fallback rules

### X syndication

Syndication can recover:

- post id, numeric author id, handle, display name, and text
- creation time, likes, replies, language, and reply parent id
- photo/video metadata on supported posts
- some quote data

It did not provide every required field in testing, notably repost count, quote
count, follower count, and following count. A syndication response therefore goes
to staging unless another source fills the missing fields. It does not become a
complete JSONL record by replacing unknown values with zero.

### Firecrawl

Firecrawl recovered readable X text, but it missed or misidentified numeric author
ids, reply and quote counts, relationships, and media. It is the final text-only
recovery path:

1. Record the URL, recovered text, provider, collection time, and error that led to
   the fallback.
2. Keep the result in staging.
3. Retry the structured source later.
4. Never infer required fields from surrounding comments or page links.

Firecrawl's better use is fetching external pages linked by tweets. The tested NASA
page returned useful content in about 1.5 seconds for one credit, but also tens of
thousands of characters of navigation. External-page text needs cleanup and belongs
in a separate enrichment path, not the tweet ingress record.

## 7. Collector boundary

The TypeScript acquisition layer writes source responses, checkpoints, and
acquisition metadata. It does not interpret a response into ingress records. The
TypeScript normalization stage reads retained raw pages and writes:

- deduplicated author and tweet JSONL matching `docs/INGRESS.md`
- author records before the first accepted tweet that references them
- structured rejection JSONL for every candidate that cannot satisfy ingress
- normalization counts and file integrity data for the run manifest

Acquisition and normalization communicate only through the documented on-disk
run layout. Normalization is deterministic and does not import the HTTP client or
make network requests. Its core mappings accept provider-shaped values and return
ingress records or rejection reasons without filesystem access. This boundary lets
a future Rust command replace normalization without changing acquisition,
checkpoints, raw files, manifests, ingress JSONL, or rejection JSONL.

Neither collection layer calculates:

- tokens, term frequencies, postings, or document frequencies
- static scores, score buckets, propagated boosts, or authority
- text or media embeddings
- query cache, feedback, answers, or config metadata

Those remain owned by the indexer and Convex functions. End-to-end compatibility
will be tested through the real indexer loading workflow when that workflow is
implemented; the pilot does not add a temporary substitute for it.

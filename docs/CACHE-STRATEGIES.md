# Cache strategies

This document names what Xearch caches, what it deliberately recomputes, and how
live ingestion affects each value. The rule is simple: cache expensive query
interpretation, not search results.

## `queryCache`

`queryCache` stores:

```text
normalized user wording -> validated XQuery refinement, paraphrases, optional HyDE text
```

It does **not** store tweet ids, rankings, engagement values, or a rendered SERP.
Every `search` subscription executes retrieval and ranking against current Convex
tables. New postings, metric refreshes, authority updates, and feedback therefore
change subscribed results without invalidating `queryCache`.

The table saves an external model call. Its indexed read is one bounded lookup by
`normalizedRaw`. A cache miss must never delay literal search; Tier A+B results
remain usable while an explicit, authorized interpretation request runs.

### Invalidation

| Change | Policy |
|---|---|
| New post or posting | No invalidation. Reactive retrieval sees the new row. |
| Engagement, authority, or feedback update | No invalidation. Ranking reads current values. |
| Lexicon behavior changes | Bump `lexiconVersion`. Search ignores rows from other versions. |
| Breaking XQuery shape | Bump `XQUERY_VERSION`. The Effect Schema codec rejects old rows. |
| User reports a wrong interpretation | `reportBadParse` deletes that wording's row. |
| Human correction exists | An LLM write cannot replace it. |
| Handle ownership or entity resolution changes | Re-resolve entity-bearing rows. This is not implemented yet; see TODO. |
| Provider or prompt changes | Do not flush automatically. Evaluate first, then add an explicit prompt/model version if results justify replacement. |

Cache rows currently have no result TTL because corpus changes cannot make an
interpretation stale. Entity-bearing rows are the exception. A cached `authorId`
can become wrong after a handle transfer or a change in entity dominance. Before
automatic live indexing broadens beyond the pilot accounts, add `resolvedAt` and
an entity-only TTL or store the candidate name and resolve it on each cache hit.
Measure the extra author read before choosing.

## Search results

Xearch does not persist result lists. Convex query subscriptions are the cache and
invalidation mechanism for the UI. Adding a SERP table would duplicate dependency
tracking, require manual invalidation for every posting and ranking update, and add
writes on the read path.

The browser may keep the last result only while it still belongs to the same
normalized query and sort order. A changed input shows a pending state rather than
old results under new text.

## Baseline full-text search

The baseline uses Convex's full-text index and does not consult `queryCache`.
Optional LLM interpretation returns a preview that the user must apply. Applying
it starts another ordinary baseline query; it does not create a cached result.

Repeated benchmark calls can hit Convex and transport caches. Benchmark output must
label warm-up and measured samples and cannot infer server execution time by
subtracting an unrelated HTTP request.

## Live feed

The live feed is a bounded reactive query over a chronological tweet index. It is
not a cache and must not scan the corpus. Each rerun reads only the newest page.

There are two clocks:

1. `createdAt` is when the source post was published.
2. `_creationTime` is when Convex received the row.

A historical backfill is recent by ingestion time but not by publication time.
The UI must label which clock it shows. The first firehose view should use arrival
time so people can see ingestion happen, while each card still displays the
source publication timestamp.

## Measurements required before changing policy

- cache hit and miss counts, split by source and lexicon version
- query-cache read latency and external model latency
- reactive feed reruns and documents read per rerun
- stale entity corrections
- result latency by query shape and sort order

Do not precompute XQuery terms from high-engagement posts. That changes query
meaning, adds ingestion writes, and biases intent toward already popular posts.
Term document frequency and score buckets already provide bounded planning and
ranking signals. Add more materialization only after a profile identifies a
specific repeated computation and a measured read/write reduction.

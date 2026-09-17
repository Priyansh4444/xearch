# Second fast source of truth (embedded Tantivy, on this machine)

**Convex remains the primary source of truth.** This lane is an ISOLATED,
optional, self-hosted search engine: it reads the same ingress JSONL the
pipeline already produces (READ-ONLY) and builds a local Tantivy inverted
index — the Lucene-family engine in pure Rust. No JVM, no server process to
operate, no network hop: queries run in-process against memory-mapped index
files the OS pages in on demand. It never writes to Convex and no existing
pipeline path (prepare / upload / fold / refresh) depends on it.

Priority order this lane was built for: memory efficiency > performance > disk.

## Run

```sh
# 1. Build the index (idempotent: each tweet is deleted by tweet_id term
#    before re-adding, so a rebuild over the same files changes nothing):
indexer/target/debug/xearch-indexer index-second --index-dir ./second-source-index \
  data/old/2026-09-03T06-45-44Z-full/ingress/records.jsonl \
  data/old/2026-09-16T08-43-18Z-expansion-0916/ingress/records.jsonl \
  data/old/2026-09-16T22-07-06Z-influencers-0916/ingress/records.jsonl

# 2. Serve the local proxy:
indexer/target/debug/xearch-indexer serve-second --port 9201 --index-dir ./second-source-index

curl 'http://127.0.0.1:9201/search?q=pricing&limit=20'
curl 'http://127.0.0.1:9201/search?author=paulg&since=1735689600000&limit=20'
curl 'http://127.0.0.1:9201/stats'
```

Optional env: `SECOND_SOURCE_INDEX_DIR` (index directory). Schema: full-text
`text` (BM25), keyword `tweet_id`/`author_id`/`author_handle`, range-capable
`createdAt` (u64 fast field). Metrics columns are intentionally NOT indexed —
the lane returns ranked text hits, not engagement stats.

## Interface

- `GET /search?q=&author=&since=&until=&limit=` — BM25 over tweet text (terms
  ANDed), author handle/id exact filter, inclusive epoch-millis time range,
  limit clamped to 200. Response: `{total, count, results:[{tweetId, text,
  authorHandle, createdAt, score}], source}` — `source` always states what
  this lane is.
- `GET /stats` — indexed doc count + the lane label.

## Measured on the dev machine (not the final server)

| metric | Tantivy lane (local, this device) | Convex (prod, network round trip) |
| --- | --- | --- |
| corpus | 257,566 tweets indexed in 18.8s (~13.7k/s, DEBUG build); rebuild idempotent (246,309 live docs) | 257,566 tweets via the ingestBatch pipeline |
| index size | 96 MB on disk (mmap readers; pages stay in page cache, not process RSS) | postings table (Convex storage) |
| query p50 / p95 | 3.0 / 3.9 ms through the proxy (40 real queries, keep-alive) | p50 ~530 ms-1.5 s from this device |
| memory | proxy RSS ~4 MB (DEBUG build); index data file-backed | n/a |
| reads against Convex | 0 | ~2,200/query after PR #43 |

Machine: 16-core laptop, powersave governor, 30 GB RAM, DEBUG-build proxy.
Numbers are device-relative; the final server will differ.

## Alternatives considered

An Elasticsearch/Lucene service lane was prototyped and measured on this
machine (257,566 tweets in 42.0s; 82 MB index; p50 19 ms / p95 24 ms through
a local proxy vs Convex p50 ~530 ms–1.5 s). It was dropped for this lane
because the priority order is memory efficiency first: ES needs a JVM
(measured ~1.1 GB RSS on a 512m–1g heap) plus an operated service, while the
Tantivy lane is one binary, mmap-backed readers, and ~single-digit MB of heap.
If the corpus ever outgrows one machine, or Lucene-only features (analyzers,
aggregations, highlighting, `more_like_this`) become load-bearing, revisit ES.

## Guarantees

- Idempotent: delete-by-`tweet_id` before add; rebuilds change nothing.
- Atomicity: the lane is read-only on `data/`; a failed build is a loud
  error, never a silent drop.
- Isolation: no Convex code path imports anything here; the existing
  indexer's prepare/upload/fold/refresh are untouched.

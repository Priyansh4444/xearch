# Second fast source of truth (self-hosted Elasticsearch/Lucene)

**Convex remains the primary source of truth.** This lane is an ISOLATED,
optional, self-hosted search engine: it reads the same ingress JSONL the
pipeline already produces (READ-ONLY), pushes it into a local Elasticsearch
index (Lucene), and serves queries through a thin local proxy. It never
writes to Convex and no existing pipeline path (prepare / upload / fold /
refresh) depends on it.

## Why

- Search speed: Convex queries cost indexed reads and round trips; this lane
  answers from the local machine's Lucene index in single-digit-to-low-ms
  time and costs Convex **zero** reads.
- Users can host Elasticsearch themselves; the lane is one subcommand away.

## Run

```sh
# 1. Start Elasticsearch 8.x/9.x somewhere (e.g. the compose file):
docker compose -f deploy/second-source/docker-compose.yml up -d
#    or: tarball + ./bin/elasticsearch with ES_JAVA_OPTS="-Xms512m -Xmx1g"

# 2. Bulk-push the corpus (idempotent: _id = tweetId, re-push overwrites):
ELASTICSEARCH_URL=http://127.0.0.1:9200 \
  indexer/target/debug/xearch-indexer index-second \
  data/old/2026-09-03T06-45-44Z-full/ingress/records.jsonl \
  data/old/2026-09-16T08-43-18Z-addendum-0916/ingress/records.jsonl \
  data/old/2026-09-16T08-57-38Z-expansion-0916/ingress/records.jsonl \
  data/old/2026-09-16T22-07-06Z-influencers-0916/ingress/records.jsonl \
  data/old/2026-09-17T02-59-58Z-influencer-no-replies/ingress/records.jsonl \
  data/old/2026-09-17T03-02-44Z-influencers-batch2/ingress/records.jsonl

# 3. Serve the local proxy:
ELASTICSEARCH_URL=http://127.0.0.1:9200 \
  indexer/target/debug/xearch-indexer serve-second --port 9201

curl 'http://127.0.0.1:9201/search?q=pricing&limit=20'
curl 'http://127.0.0.1:9201/search?author=paulg&since=1735689600000&limit=20'
curl 'http://127.0.0.1:9201/stats'
```

Optional env: `ELASTICSEARCH_API_KEY` (encoded API key), `SECOND_SOURCE_INDEX`
(index name; tests set it). English analyzer = Lucene tokenized + stemmed.

## Interface

- `GET /search?q=&author=&since=&until=&limit=` — BM25 over tweet text (AND
  operator), author handle/id exact filter, inclusive epoch-millis time range,
  limit clamped to 200. Response: `{total, count, results:[{tweetId, text,
  authorHandle, createdAt, score}], source}` — `source` always states what
  this lane is.
- `GET /stats` — indexed doc count + the lane label.

## Measured on the dev machine (not the final server)

| metric | Elasticsearch/Lucene lane (local) | Convex (prod, network round trip) |
| --- | --- | --- |
| corpus | 257,566 tweets bulk-pushed in 42.0s (6.1k/s, DEBUG build; idempotent re-push verified) | 257,566 tweets via ingestBatch pipeline |
| index size | 82 MB on disk (1 shard, 0 replicas) | postings table (Convex storage) |
| query p50 / p95 | 19 / 24 ms (proxy included; direct ES ~14.5 ms) | 1,555 / 3,438 ms |
| memory | proxy process RSS ~4 MB; ES JVM 512m-1g heap (measured ~1.1 GB RSS) | n/a |
| reads against Convex | 0 | ~2,200/query after PR #43 |

Machine: 16-core laptop, powersave governor, 30 GB RAM, ES 8/9 single node,
DEBUG-build proxy. Numbers are device-relative; the final server will differ.

## Guarantees

- Idempotent: `_id = tweetId`, re-push overwrites, docs count unchanged.
- Atomicity: the lane is read-only on `data/`; a failed bulk batch is a loud
  error, never a silent drop.
- Isolation: no Convex code path imports anything here; the existing
  indexer's prepare/upload/fold/refresh are untouched.

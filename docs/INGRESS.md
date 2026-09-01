# Ingress contract: what data collection must deliver

The indexer consumes **JSONL files in a watched directory** (or stdin in `tail`
mode). One JSON object per line, UTF-8, LF. Two record kinds discriminated by
`"kind"`. However the collector obtains data — API, export, scrape, synthetic — it
lands in this shape and nothing downstream knows the difference. Rust types:
`indexer/src/model.rs` (serde is the validator). Source priority, tested field
mappings, fallbacks, and the repost policy live in `docs/COLLECTION.md`.

## 1. Tweet record

```jsonc
{
  "kind": "tweet",
  "id": "1750000000000000001",          // REQUIRED, source id, dedupe key
  "text": "the pricing on these linux boxes is outrageous lol",
                                         // REQUIRED: full, HTML-entities decoded,
                                         // emoji intact, never truncated
  "authorId": "44196397",               // REQUIRED
  "createdAt": 1721088000000,           // REQUIRED, epoch ms UTC
  "metrics": {                          // REQUIRED (zeros ok)
    "likes": 12, "retweets": 3, "quotes": 4, "replies": 5
  },
  "metricsAt": 1721090000000,           // REQUIRED — engagement without a
                                         // snapshot time is meaningless
  "media": [                            // REQUIRED, may be []
    { "type": "image", "url": "https://..." }   // image|video|gif
  ],
  "quotedTweetId": null,                // REQUIRED KEYS, null ok — these three
  "retweetOfTweetId": null,             // edges are the interaction graph
  "inReplyToTweetId": "17499...",       // (Tweepcred, boost propagation, RT dedup)
  "lang": "en",                         // optional
  "entities": {                         // optional; indexer derives if absent
    "hashtags": ["linux"], "mentions": ["theo"], "urls": ["https://..."]
  }
}
```

## 2. Author record

```jsonc
{
  "kind": "author",
  "id": "44196397",                     // REQUIRED
  "handle": "theo",                     // REQUIRED, no @, original case ok
  "displayName": "Theo — t3.gg",        // REQUIRED
  "followerCount": 350000,              // REQUIRED
  "followingCount": 900,                // REQUIRED — Tweepcred's follow-farm
                                         // ratio adjustment needs it
  "verified": true,                     // REQUIRED
  "createdAt": 1234567890000,           // REQUIRED
  "bio": "…", "avatarUrl": "…"          // SHOULD
}
```

## 3. Collector rules

1. **Idempotence is the update mechanism.** Re-emitting an id with newer
   `metricsAt` = metrics update. Re-emitting with same/older `metricsAt` = no-op.
   Never emit two *different texts* for one id (edits → treat as delete+new id, or
   skip).
2. **Edges survive even when targets don't.** Keep `quotedTweetId` etc. even if the
   referenced tweet was never collected. Dangling edges are useful (graph mass);
   stripped edges are unrecoverable.
3. **Author records precede or accompany their tweets** in file order when possible;
   the indexer tolerates orphans by upserting stub authors (handle = id) that later
   author records enrich.
4. **Metric re-crawl:** tweets < 48h old SHOULD be re-emitted on a schedule
   (suggest: at 1h, 6h, 24h, 48h). Engagement moves early then freezes; the refresh
   pass re-buckets from these.
5. **File discipline:** files named `{source}-{epochMs}.jsonl`, append-only, moved to
   `done/` after ack'd checkpoint. Malformed lines get quarantined by the indexer —
   collectors are not trusted, they're validated.

## 4. Corpus shaping (demo quality is a collection problem)

- **≥1M tweets**, but concentration beats breadth: pick 3–5 communities (e.g. tech
  twitter, F1 twitter, cooking twitter) and go DEEP — demo queries need dense
  result sets, and Tweepcred needs a connected interaction graph, not isolated
  stars.
- **Media-rich accounts included deliberately** (image search needs images).
- **Thread/quote chains included whole** when feasible — they exercise boost
  propagation and conversation features; isolated viral tweets don't.
- **Time depth matters**: include months of history for the recency decay and
  event-window queries to be demonstrable; an all-last-week corpus makes `since:`
  filters pointless.
- Skew warning: if one account is 30% of the corpus, authority and engagement
  signals degenerate. Cap any single author at ~2% of total.

## 5. Quality gates (indexer enforces, collector aims)

| Gate | Threshold | On violation |
|---|---|---|
| JSON parse + required fields | 100% | line → quarantine file + counter |
| `text` non-empty after strip | — | quarantine |
| `createdAt`/`metricsAt` sane (2006 < t ≤ now+5m) | — | quarantine |
| Duplicate id ratio per file | < 20% | warn (collector likely re-crawling too hot) |
| Orphan tweet ratio (author never seen) | < 10% by end of backfill | warn; stub authors degrade authority quality |

# Risk register: what goes wrong, and the compromise we take

Each row is a real failure mode, the moment it bites, and the *deliberate* compromise
we accept instead of solving it fully. If a row's compromise stops being acceptable,
that's a design conversation, not a patch.

## Retrieval & index

| # | What goes wrong | When it bites | Compromise we take |
|---|---|---|---|
| R1 | **Capped intersection misses a good doc** — impact-ordered caps drop a tweet that's mediocre for one term but great overall | Common-term + common-term queries (`ai agents`) on a large corpus | Accept approximate top-k (unsafe-up-to-cap, like practical WAND deployments). Mitigate: rarest-first, N=1000, ladder L2 union catches near-misses. We do NOT chase exactness — that's full list scans |
| R2 | **Hot terms during live demo** — trending term's postings churn while thousands read | Demo day, ingest running | Convex OCC retries mutations; readers never block (MVCC). Accept transient extra mutation latency; df counters drift slightly (advisory only) |
| R3 | **Index bloat: 5 indexes on postings ≈ 5× storage** | >5M tweets on a paid plan | Pay it until it hurts, then drop `by_term_media_score` → media filtering moves to rerank. Ordered drop list in DESIGN §9 |
| R4 | **Deletes/edits leave dangling postings** | Ingesting takedowns/edits | `by_tweet` index + O(terms) cleanup mutation; accept eventual consistency (a deleted tweet can flash in results between crawl and cleanup) |
| R5 | **Skew: one author or one day dominates a term's top-N bucket range** | Fan communities, spam bursts | Accept for hackathon; post-hackathon: per-author dedup at rerank (keep top-2 per author per SERP) |

## Tokenizer & parity

| # | What goes wrong | When it bites | Compromise we take |
|---|---|---|---|
| T1 | **Rust and TS tokenizers drift** — one recall bug, invisible until someone compares | Any tokenizer change | Golden fixture (`shared/fixtures/tokenizer-golden.jsonl`) run by BOTH test suites; divergence = red CI, not silent bug. Compromise: goldens only cover what we thought to write down |
| T2 | **CJK/Thai have no spaces** — word-boundary rules produce garbage terms | First Japanese tweet | Explicit compromise: CJK runs are indexed as overlapping **bigrams** (standard CJK IR fallback), no dictionary segmentation. Worse precision than MeCab-style, zero dependency risk, same rule in both twins |
| T3 | **Emoji/ZWJ sequences split weirdly** | 🤣 skin-tone/family emoji | Treat extended-pictographic runs as single tokens; accept that ZWJ families may split in rare cases (golden-tested for the common ones) |
| T4 | **`$` collides: cashtags vs prices** — `$TSLA` is an entity, `$99` is a price signal | Finance + commerce queries | Rule: `$` + letters → cashtag token; `$` + digits → `~price` aspect. Ambiguous forms (`$1M2`) fall to plain tokens. Documented, golden-tested |

## Parser (Loose Parser)

| # | What goes wrong | When it bites | Compromise we take |
|---|---|---|---|
| P1 | **Entity linking overfires** — `jack` links to @jack when the user meant jack (the noun) | Ambiguous first names | Link only when top candidate authority dominates 10× AND the token isn't also a high-df common word; otherwise keep as term. Accept under-linking over wrong-linking (wrong filter = invisible correct results — the worst failure class) |
| P2 | **Tier C returns a *valid but wrong* parse** — grammar guarantees shape, not sense | Weird prose queries | Cached bad parse = consistently bad. Compromise: "report bad parse" affordance busts the cache row; golden eval set gates model/prompt changes. We do NOT attempt online parse-confidence estimation |
| P3 | **Negated aspect queries collapse** — `not expensive` maps to `~price` same as `expensive` | Polarity-sensitive queries | Accept: aspect = topic-of-conversation, polarity handled by `should` terms at rerank. Documented in ASPECTS.md §4; revisit only with eval evidence of real harm |
| P4 | **Date lexicon misfires** — `march` the month vs `march` the verb/name | `million man march tweets` | Temporal words only bind when adjacent to prepositions/patterns (`in`, `since`, `last`); bare month names stay terms. Accept missed date filters over wrong ones (same asymmetry as P1) |
| P5 | **Tier A/B and Tier C disagree** — LLM lands a different IR after results rendered | Every Tier C query | By design (progressive enhancement): page visibly re-sorts. Accept the flicker; label the upgrade ("refined interpretation") so it reads as feature, not bug |

## Ranking & feedback

| # | What goes wrong | When it bites | Compromise we take |
|---|---|---|---|
| K1 | **Engagement snapshot is stale** — scoreBucket lags live counts | Viral tweets in first hours | Two-phase ranking absorbs it: retrieval order approximate, rerank reads live counts. Accept that a tweet going viral *right now* may sit in a low bucket until refresh re-buckets it (≤48h re-crawl SLA) |
| K2 | **Feedback brigading** | Public demo with a vote button | Clamp ±5 per (queryKey, tweet), one vote/session, rerank-only. Accept that determined abuse can bury one result in one query — bounded blast radius is the design, not a leftover |
| K3 | **Tweepcred favors old accounts / penalizes new quality authors** | Fresh accounts in demo corpus | Blend: `authority = max(tweepcred, 0.5·log1p(followers))` floor. Accept imperfect cold-start rather than tuning a second model |
| K4 | **Hand-tuned weights overfit our own taste** | Judge queries we never tried | Golden judgment set (docs/PARSER.md §6 format) + nDCG@10 tracked per change; weights live in one config file so tuning is a diff, not a hunt |
| K5 | **Boost propagation double-counts** — quote engagement added to target AND quote ranks itself | Quote-storm threads | One-hop only, 0.5× discount, and SERP-level dedup collapses quote chains to best representative. Accept mild inflation over graph traversal cost |

## Vectors & LLM lanes

| # | What goes wrong | When it bites | Compromise we take |
|---|---|---|---|
| V1 | **Embedding backfill lags corpus** — L4 recall silently thin early on | First days of indexing | `matchedVia` labels make thinness visible; backfill prioritizes most-engaged tweets first. Accept partial semantic coverage over blocking ingest on embedding throughput |
| V2 | **HyDE hallucinates a hypothetical about entities the model doesn't know** | Niche/community jargon | HyDE only *adds* a candidate list into RRF — it can add noise, not remove hits. Accept occasional noise; RRF's rank discount bounds the damage |
| V3 | **Answer mode cites confidently from weak retrieval** | Sparse-corpus questions | Refuse-to-answer floor on top BM25/cosine scores; answer says "not enough in the corpus". Accept lower answer coverage over hallucinated summaries |
| V4 | **Vector results don't live-update** (actions, not queries) | Watching a SERP during ingest | Accept: lexical results stream, semantic strays refresh per search submit. Documented UI behavior, not a bug |

## Operations

| # | What goes wrong | When it bites | Compromise we take |
|---|---|---|---|
| O1 | **Indexer crash mid-batch** | Always, eventually | Atomic batch mutation + checkpoint-after-ack + idempotent upserts → re-run is safe. Accept duplicate *work*, never duplicate *data* |
| O2 | **OCC contention on `terms.df` hot keys** | Backfill at full speed | Per-batch df aggregation (one write per term per batch) + jittered backoff; if still hot, shard df into K counter rows summed at read. Stage 2 only if measured |
| O3 | **Convex function limits** (16k reads/query, 1MiB doc, 8k array) | Big OR queries, giant batches | Every read path carries an explicit `limit` (ReadPlan type); batches sized ~100 tweets. Limits are inputs to the design, not surprises |
| O4 | **Config drift** — which lexicon/weights indexed this corpus? | Debugging relevance a week later | `meta` table records active config hash per ingest run; lexicons/weights are versioned files. Accept manual reindex when lexicon changes materially (no auto-migration) |

## The compromises we're explicitly NOT making

- **No exact top-k guarantee** (R1) — but never silent: `ladder`/`matchedVia` tell the UI what relaxed.
- **No auto mode-switching** into AI answers — explicit user action only (DESIGN §4.1).
- **No filter relaxation** — `from:@theo` means theo at every ladder level.
- **No unversioned wire types** — all five contracts carry versions/fixtures (ARCHITECTURE.md).

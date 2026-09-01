# Xearch

A search engine for tweets, better than the bird's. Convex holds every byte of
serving state; a Rust indexer feeds it 24/7; React 19 renders a reactive SERP that
upgrades itself as smarter interpretations land.

## Read in this order

1. [DESIGN.md](DESIGN.md) — what we're building and why (algorithms, ranking, scale)
2. [ARCHITECTURE.md](ARCHITECTURE.md) — module map, the five contracts, design rationale
3. [docs/RISKS.md](docs/RISKS.md) — what goes wrong + the compromise we take, per row
4. [docs/PARSER.md](docs/PARSER.md) — the Loose Parser made concrete (schema, prompt, evals)
5. [docs/ASPECTS.md](docs/ASPECTS.md) — aspect tokens: gripes, prior art, escalation plan
6. [docs/INGRESS.md](docs/INGRESS.md) — what data collection must deliver (JSONL contract)
7. [docs/COLLECTION.md](docs/COLLECTION.md) — collection goals, sources, mappings, and retention

## Layout

```
convex/            all serving state + query-side logic
  schema.ts        tables + indexes (each index is named in a ReadPlan)
  engine/          PURE domain library — no ctx, unit-testable
    xquery.ts      the canonical IR + queryKey        [contract #3]
    tokenize.ts    tokenizer twin B                   [contract #4]
    parse.ts       Loose Parser Tiers A + B
    plan.ts        recall-ladder planner (bounded reads, in types)
    rank.ts        near-binary BM25 + engagement + authority + RRF
  search.ts        public query (the thin shell) + typeahead + baseline
  ingest.ts        internal mutations                 [contract #2]
  feedback.ts      👍/👎 keyed by queryKey
  tierC.ts         LLM semantic layer (action, cached)
  answers.ts       AI answer mode (explicit user action only)
  vector.ts        ladder L4 semantic rescue + image search
collector/         FxTwitter source reliability tooling
  fxtwitter.ts     bounded-retry API client
  probe.ts         resumable profile-timeline probe CLI
indexer/           Rust, stateless — crashes are boring
  src/model.rs     ingress + wire types               [contracts #1, #2]
  src/tokenizer.rs tokenizer twin A                   [contract #4]
  src/pipeline.rs  tweet -> postings/buckets/aspects
  src/tweepcred.rs weighted PageRank authority
shared/            single sources of truth
  lexicons/        aspects.json, stopwords.json (versioned)
  fixtures/        tokenizer + parser goldens         [contracts #4, #5]
tests/             TS golden test (Rust twin has its own in-crate)
```

## Status

Design + contracts scaffolded; bodies marked `not implemented` are the build list.
Suggested order (dependencies, not a schedule): tokenizer twins vs golden fixture →
`ingest.ingestBatch` + indexer backfill → `tierB` + `planL0`/`escalate` → `rerank` →
`search` wiring → tierC → vectors/answers.

## Running

```sh
pnpm install && pnpm dev        # generates convex/_generated, deploys schema
pnpm test                       # TS golden tests
pnpm collect:probe NASA         # probe a resumable FxTwitter profile timeline
cd indexer && cargo test        # Rust golden tests (same fixture)
```

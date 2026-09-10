# Xearch

A search engine for archived posts. Convex holds serving state, a Rust indexer
loads collected data, and React renders subscribed search results. The web app
defaults to literal baseline search; the experimental posting-index lane remains
available through the lane toggle.

## Read in this order

1. [CONTEXT.md](CONTEXT.md) — canonical project language
2. [DESIGN.md](DESIGN.md) — what we're building and why (algorithms, ranking, scale)
3. [ARCHITECTURE.md](ARCHITECTURE.md) — module map, the five contracts, design rationale
4. [docs/RISKS.md](docs/RISKS.md) — what goes wrong + the compromise we take, per row
5. [docs/PARSER.md](docs/PARSER.md) — the Loose Parser made concrete (schema, prompt, evals)
6. [docs/ASPECTS.md](docs/ASPECTS.md) — aspect tokens: gripes, prior art, escalation plan
7. [docs/INGRESS.md](docs/INGRESS.md) — what data collection must deliver (JSONL contract)
8. [docs/COLLECTION.md](docs/COLLECTION.md) — collection goals, sources, mappings, and retention
9. [docs/collection/01-pilot.md](docs/collection/01-pilot.md) — the 62-account pilot: accounts, stop rules, run lifecycle, commands

## Layout

```
apps/
  web/               React 19 SERP (Vite) over the baseline search lane
  collector/         TypeScript collection (docs/collection/01-pilot.md)
    src/
      acquisition/   FxTwitter HTTP, retries, profile + timeline envelopes
      config/        pilot config parsing (pinned ids, cohorts)
      pilot/         run layout, checkpoint/manifest, acquire, lifecycle, report
      normalization/ pure provider -> ingress mapping + deterministic normalizer
      probe/         resumable source-reliability probe
      cli/           executable entry points (pilot, probe)
    tests/           collector tests + provider-shaped golden fixtures
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
config/
  collection/      language-neutral collection run definitions
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

Working end to end on xearch's own index, deployed to the prod deployment
(`sleek-emu-128`, the one holding the 164,959-post archived corpus): tokenizer
twins pass the shared golden fixture, `ingest.ingestBatch` + the Rust `backfill`
loop loaded the corpus, and the full `search` query runs Tier A+B parsing
(operators, dates, entities, aspects, glue), a Tier C refinement merge from
`queryCache` (one bounded point read; fill-only, operator slots always win), the
L0–L3 recall ladder with bounded reads (it widens only queries with two or more
terms — one term's exact result set is already complete), and the deterministic
reranker with live feedback votes.
`from:@handle`). `ingest.applyMetrics` / `ingest.upsertAuthority` (refresh-mode
verbs) are live. `tierC.refine` is an internal action (cache-first, JSON-schema
constrained, entity strings resolved with the dominance rule); it stays dormant
until `TIERC_LLM_URL` / `TIERC_LLM_MODEL` / `TIERC_LLM_KEY` are set on the
deployment, and is internal-only until auth/quotas exist (TODO P0).
`pnpm bench:search` measures client-observed latency and result-count floors.
Production first-observed requests ranged from 499 ms to 8.7 s while immediate
repeats ranged from 84 ms to 152 ms. These observations do not isolate server
execution, establish a speedup, or measure Recall@20; see
[docs/SEARCH-BENCHMARK.md](docs/SEARCH-BENCHMARK.md). `apps/web` defaults to the
strict literal baseline and provides bounded pagination, Top/Recent sorting,
client-observed timing, typeahead, authenticated feedback, optional reviewed AI
interpretation, an opt-in arrival feed, and an experimental Xearch lane.
The deployed web app is <https://xearch-web.pronsh.workers.dev> and connects to
the production Convex corpus at `sleek-emu-128`.
Remaining build list: vectors/answers → indexer tail/refresh (Tweepcred, boost
propagation) → auth for votes + public Tier C triggers.

The review fixes documented in [docs/SEARCH-REVIEW.md](docs/SEARCH-REVIEW.md)
are deployed. Voting requires trusted Convex identity; no auth provider is
configured, so anonymous users have no voting controls. Corrected aspect mapping
changes the indexer config hash and requires a deliberate reindex in a separate
deployment, not a checkpoint deletion against the existing corpus — the live
corpus still carries the old weak-aspect postings, so aspect-gated queries
(`~price` …) over-match until that reindex happens.

## Running

```sh
pnpm install                    # generated Convex bindings are committed
pnpm codegen                    # regenerate bindings after backend changes; needs deployment access
pnpm dev                        # run Convex dev and the web app together
pnpm dev:convex                 # backend watcher only; writes to your configured dev deployment
pnpm test                       # TS golden tests
pnpm collect:probe NASA         # probe a resumable FxTwitter profile timeline
pnpm collect:pilot acquire --accounts theo --label smoke   # resumable pilot run
apps/collector/scripts/acquire-detached.sh --run <id>      # long runs: detached, logs in data/logs/
pnpm collect:pilot normalize <run-id>                      # validate, report, archive
pnpm collect:pilot verify <run-id>                         # byte-for-byte re-normalization
pnpm collect:sync [run-id]                                 # mirror data/old to R2 (needs .env.r2)
pnpm collect:pull <run-id> [pattern ...]                   # read-only pull from R2: manifest + ingress,
                                                           # digest-verified against the manifest
pnpm web                        # web only; defaults to sleek-emu-128 when no URL override is set
pnpm deploy:web                 # build and deploy static assets with Wrangler

# index a pulled run into the deployment in .env.local (CONVEX_URL + CONVEX_DEPLOY_KEY):
cd indexer && cargo build --release && cd ..
indexer/target/release/xearch-indexer \
  --data-dir data/old/<run-id>/ingress --checkpoint ./checkpoint.json backfill
pnpm typecheck                  # offline tsc over apps/, convex/, tests/ (no deployment needed)
cd indexer && cargo test        # Rust golden tests (same fixture)
```

`VITE_CONVEX_URL` overrides the web endpoint; otherwise the root `.env.local`
`CONVEX_URL` wins, then the production URL `https://sleek-emu-128.convex.cloud`.
Use `pnpm web` to view production without starting a backend watcher.

## Search limitations and optional demos

Baseline requires every meaningful query token, verifies phrases/exclusions and
explicit filters, and never repairs spelling automatically. Stopwords are the one
exception to "meaningful": a query made only of them (`and so is`, `"to be"`)
stays searchable, because the built-in full-text index keeps stopwords even though
the posting index skips them. Top orders whichever candidate page retrieval
returned with the same deterministic ranker in both lanes (`engine/rank.ts`), so
the lanes differ in retrieval, not in what "Top" means; Latest orders the bounded
window, not all matching posts in the archive. The posting lane never widens a
single-term query: its exact result set is already complete.
See [constraints.md](constraints.md) for known failure cases.

The home page's opt-in arrivals panel subscribes to the newest 20 inserted posts.
It does not start collection, use the X API, or imply that the source is live.
New arrivals require an existing ingest process.

AI interpretation is a query rewrite, not an answer. The UI requires Interpret
then Apply, and Apply uses the same baseline executor. Public interpretation is
currently unavailable until the provider, authentication and quota policy are
approved. The internal `interpret.preview` action validates model words and
preserves original explicit operators. No paid model calls were used to validate
this change. Do not expose the internal action anonymously.

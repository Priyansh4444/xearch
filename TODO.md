# TODO

Source notes from comparative research vs t3code (2026-09-08): do **not** rewrite the pure engine "in Effect like T3." Convex already owns the reactive/distributed model; keep `convex/engine` pure (parse → plan → bounded reads → rerank). Borrow from T3 at the edges: centralized runtime contracts, typed errors, compatibility codecs, structured observability, lifecycle at collector/indexer, and CI.

### Small but effective tasks which require lower-mid tier reasoning

- [x] make collector errors typed using Effect (`FsError`, `FxTwitterError`, `PilotConfigError`, `LifecycleError`, `Probe*Error`, `PilotCliError`, checkpoint/account TaggedErrors)
- [x] move FxTwitterClient to functional `makeFxTwitterClient` with Effect retries/backoff/schema validation
- [x] close shared string unions as const enums + Schema.Literals (`AccountState`, `PauseReason`, `AcquisitionStatus`, `DiscoveryResolution`, `PageOutcome`, provider/media/normalize-kinds; engine `Intent`/`SortOrder`/`LadderLevel`/`MediaType`)
- [x] `cargo bench` baselines (2026-09-09, `indexer/benches/`): `tokenizer/shared_goldens` ~12.9µs/12 texts (~930k texts/s); `pipeline/push_tweet_mixed_corpus` ~150µs/8 tweets (~53k tweets/s, ~100x the 500/s backfill target) — transform is not the bottleneck, Convex ack throughput is; gate any concurrent-pipeline work on these numbers
- [x] retire stale R2 helpers (`run-snapshot` wrote to the dead `_active/` prefix; `finish-run` / `push-status-loop` unreferenced by scripts/docs/tests) — live ops kept: `pull-run` / `push-status` / `sync-runs` / `acquire-detached` + dashboard Worker; dashboard serves `<run-id>/` + `_live/` only
- [x] cut spread temporaries on hot paths (`uniqueTerms` single-Set union in plan/search ×4 sites; `maxSignal` loop replacing 3× `Math.max(...map)` per rerank) — goldens green, identical behavior; remaining spreads build necessary outputs (sorted copies, result shapes)
- [x] migrate collector I/O to Effect (`Effect.fn` throughout acquire/discover/manifest/report/lifecycle/normalize I/O/probe/CLI/config/fs). Leave tokenize/parse/plan/rank/eval pure.
- [x] extract SearchErrorBoundary fallback UI to a functional component (class shell required by React)
- [x] branded domain IDs (Effect Schema brands in collector `contracts/ids.ts`; type-only brands in `convex/contracts/ids.ts` so validators stay `v.string()` and canonical XQuery JSON is unchanged; doc `_id` vs source-id spaces documented, not renamed)
- [x] Dependabot/Renovate + lockfile verification (`.github/dependabot.yml` for npm/cargo/actions weekly; lockfile verified by CI's `pnpm install --frozen-lockfile`)
- [x] `Context.Service` + Layers where DI helps tests (`FxTwitter` tag + `FxTwitterLive`/`FxTwitterTest` layers; probe CLI composed via `Effect.provide`, acquisition specs provide fakes + TestClock) — acquire/discover keep explicit client args, no service graph
- [x] `it.effect` for collector Effect tests via local `tests/effect.ts` (TestClock-backed, same ergonomics) — `@effect/vitest` itself blocked: its rc track peers vitest <5 while the repo runs vitest 5; switch the import when it catches up

### P0 — highest return, do before algorithm / auth-risky work

- [x] **CI:** `.github/workflows/ci.yml` — `pnpm typecheck` / `pnpm test`, Rust fmt/clippy/test; Node 24 via `.nvmrc` + `engines`
- [ ] **reproducible search/index benchmark harness** before changing caps/ranking: current ~165k corpus + labeled queries; gate on p50 ≤ 50 ms *and* Recall@20 vs uncapped offline oracle (target ≥ 99% on fixed set; report head-term cap misses separately)
  - `pnpm bench:search` measures first-observed and repeat client latency plus result-count floors. The audit reproduced 499 ms-8.7 s first requests and 84-152 ms repeats. It does not isolate server execution or prove a speedup. Server timing and Recall@20 against an uncapped offline oracle remain open; see `docs/SEARCH-BENCHMARK.md`.
- [ ] **production auth / abuse controls** before enabling public feedback or expensive Tier C / answer / vector lanes: Convex auth for voting, per-user/per-query quotas, keep `ingestBatch` credential out of client bundles, hard max lengths on terms/phrases/filters/expansions/result limits

### P1 — contracts, ingest, retrieval policy, observability

- [ ] **canonical XQuery as Effect Schema codec**; derive the TS type from it; keep Rust on the stable JSON shape + goldens (no Effect in Rust). Reduce TS interface / Convex validator / docs / JSON Schema drift
  - first half landed (2026-09-09): `engine/xquery.ts` validates untrusted cache rows / Tier C output through an Effect Schema wire codec (`parseXQueryJson`). Deriving the `XQuery` TS type from the schema (and unifying the type-only brands with Schema brands) still open.
- [ ] **forward-compatible codecs** at versioned boundaries (unknown future enum/union members decode to absence rather than hard-fail) where clients/indexers may roll independently
- [ ] **bounded concurrent indexer pipeline**: JSONL → bounded CPU tokenize workers → ordered batch assembler → at most N Convex mutations in flight; advance checkpoints only for the highest contiguous successful range (do not sacrifice crash correctness for throughput)
- [ ] **measure then adapt posting caps** by term DF / query shape (hypothesis only — compare fixed 500/1000/2000 vs adaptive budgets on recall@20, reads/query, p95; do not merge from intuition)
- [ ] **structured query + ingest metrics/traces** (at least): `search.total_ms`, `parse/plan/retrieval/rerank/hydrate.ms`, `query.term_count/ladder_level/postings_read/candidates/cap_hit/results`, `ingest.records/bytes/batch_tweets/batch_df_terms/batch_ms/retry_count/quarantine_count`
- [ ] **judge exact vs expanded ranking:** the production-sample characterization proves a viral one-term L2 result can outrank a quiet two-term exact result. Choose exact-first partition vs a must-coverage feature only after the `docs/RANKING-EVALUATION.md` gate.
- [ ] **query-cache lifecycle before broad live indexing:** keep result lists uncached; add prompt/model provenance; measure hit rate; add `resolvedAt` plus either entity-only TTL or read-time re-resolution for cached author fills. See `docs/CACHE-STRATEGIES.md`.
- [ ] **conservative spelling suggestions:** never rewrite automatically. On an empty literal result, offer an explicit user-applied correction only when an indexed term has strong evidence and the input is not an operator, handle, cashtag, hashtag, URL, acronym, emoji, or known term. The first fixture keeps `conevx` literal until this policy and its negative tests land.
- [ ] **corpus provenance** on ingest: source, normalization version, tokenizer version, batch/checkpoint so deletions/corrections are reproducible
- [ ] scale modeling at 1M / 5M / 10M posts (Zipfian term + author skew): posting reads, bytes/read, index bytes/post, cap-hit rate — index amplification and hot-term caps are the first risks to quantify

### Things that should be it's own PR/Stacked PR and require higher reasoning

- [ ] Attempt builing a Xquery client. Take heavy inspiration from other vendors
- [ ] Attempt building a simpler non Xquery client which is just raw for search
- [ ] Finishing out Convex Engine
- [ ] Simplifying the Data Structures and Tables to be MATHEMATICALLY the most efficient for retrieval
- [ ] finish incomplete lanes called out in README: vector retrieval, AI answers, tail-refresh — behind rate limits + cache keys, not on the Tier A/B hot path
- [ ] parser stress fixture (~10k): handles, cashtags, emoji, CJK, phrases, excludes, filters — parse µs, allocations, golden/slot-F1 agreement

### P2 — only after profiling / evidence

- [ ] JS allocation / top-k sort tweaks in reranker **only if** profiling shows ranking CPU dominates (likely small end-to-end win if DB-bound)
- [ ] single WASM tokenizer **only if** TS/Rust drift or dual-edit cost crosses the scrap trigger already noted in design docs
- [ ] operational runbooks (deploy, ingest resume, quarantine, auth) — design docs are strong; ops enforcement lags

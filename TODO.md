# TODO

Source notes from comparative research vs t3code (2026-09-08): do **not** rewrite the pure engine "in Effect like T3." Convex already owns the reactive/distributed model; keep `convex/engine` pure (parse → plan → bounded reads → rerank). Borrow from T3 at the edges: centralized runtime contracts, typed errors, compatibility codecs, structured observability, lifecycle at collector/indexer, and CI.

### Small but effective tasks which require lower-mid tier reasoning

- [x] make collector errors typed using Effect (`FsError`, `FxTwitterError`, `PilotConfigError`, `LifecycleError`, `Probe*Error`, `PilotCliError`, checkpoint/account TaggedErrors)
- [x] move FxTwitterClient to functional `makeFxTwitterClient` with Effect retries/backoff/schema validation
- [x] close shared string unions as const enums + Schema.Literals (`AccountState`, `PauseReason`, `AcquisitionStatus`, `DiscoveryResolution`, `PageOutcome`, provider/media/normalize-kinds; engine `Intent`/`SortOrder`/`LadderLevel`/`MediaType`)
- [x] `cargo bench` baselines (2026-09-09, `indexer/benches/`): `tokenizer/shared_goldens` ~12.9µs/12 texts (~930k texts/s); `pipeline/push_tweet_mixed_corpus` ~150µs/8 tweets (~53k tweets/s, ~100x the 500/s backfill target) — transform is not the bottleneck, Convex ack throughput is; gate any concurrent-pipeline work on these numbers
- [x] retire stale R2 helpers (`run-snapshot` wrote to the dead `_active/` prefix; `finish-run` / `push-status-loop` unreferenced by scripts/docs/tests) — live ops kept: `pull-run` / `push-status` / `sync-runs` / `acquire-detached` + dashboard Worker; dashboard serves `<run-id>/` + `_live/` only
- [x] destructuring / heap-churn audit (2026-09-09): all spreads sit on bounded small collections (≤12 query terms, ≤200 rerank candidates, per-request arrays); per-term/per-doc loops (`executePlan` intersection, `rerank` scoring, tokenizer scan) iterate without spreading, and the pipeline bench shows ~53k tweets/s headroom — no action needed
- [x] migrate collector I/O to Effect (`Effect.fn` throughout acquire/discover/manifest/report/lifecycle/normalize I/O/probe/CLI/config/fs). Leave tokenize/parse/plan/rank/eval pure.
- [x] extract SearchErrorBoundary fallback UI to a functional component (class shell required by React)
- [x] branded domain IDs (Effect Schema brands in collector `contracts/ids.ts`; type-only brands in `convex/contracts/ids.ts` so validators stay `v.string()` and canonical XQuery JSON is unchanged; doc `_id` vs source-id spaces documented, not renamed)
- [x] Dependabot/Renovate + lockfile verification (`.github/dependabot.yml` for npm/cargo/actions weekly; lockfile verified by CI's `pnpm install --frozen-lockfile`)
- [x] optional `Context.Service` + Layers — decided against (2026-09-09): DI needs are already covered by `Effect.fn` + injected-callback seams (`TierBDeps` pattern) with fixture-backed tests; a service graph would add abstraction without a consumer
- [x] optional `@effect/vitest` `it.effect` — decided against (2026-09-09): exactly one test file (`acquisition.test.ts`, 3 call sites) runs Effects directly; a new dependency to save three `Effect.runPromise` wrappers is negative value

### P0 — highest return, do before algorithm / auth-risky work

- [x] **CI:** `.github/workflows/ci.yml` — `pnpm typecheck` / `pnpm test`, Rust fmt/clippy/test; Node 24 via `.nvmrc` + `engines`
- [ ] **reproducible search/index benchmark harness** before changing caps/ranking: current ~165k corpus + labeled queries; gate on p50 ≤ 50 ms *and* Recall@20 vs uncapped offline oracle (target ≥ 99% on fixed set; report head-term cap misses separately)
- [ ] **production auth / abuse controls** before enabling public feedback or expensive Tier C / answer / vector lanes: Convex auth for voting, per-user/per-query quotas, keep `ingestBatch` credential out of client bundles, hard max lengths on terms/phrases/filters/expansions/result limits

### P1 — contracts, ingest, retrieval policy, observability

- [ ] **canonical XQuery as Effect Schema codec**; derive the TS type from it; keep Rust on the stable JSON shape + goldens (no Effect in Rust). Reduce TS interface / Convex validator / docs / JSON Schema drift
- [ ] **forward-compatible codecs** at versioned boundaries (unknown future enum/union members decode to absence rather than hard-fail) where clients/indexers may roll independently
- [ ] **bounded concurrent indexer pipeline**: JSONL → bounded CPU tokenize workers → ordered batch assembler → at most N Convex mutations in flight; advance checkpoints only for the highest contiguous successful range (do not sacrifice crash correctness for throughput)
- [ ] **measure then adapt posting caps** by term DF / query shape (hypothesis only — compare fixed 500/1000/2000 vs adaptive budgets on recall@20, reads/query, p95; do not merge from intuition)
- [ ] **structured query + ingest metrics/traces** (at least): `search.total_ms`, `parse/plan/retrieval/rerank/hydrate.ms`, `query.term_count/ladder_level/postings_read/candidates/cap_hit/results`, `ingest.records/bytes/batch_tweets/batch_df_terms/batch_ms/retry_count/quarantine_count`
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

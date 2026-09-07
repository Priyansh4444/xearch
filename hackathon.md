# Hackathon log

- **Project:** Xearch
- **Event:** Convex All Gas Hackathon
- **What it does:** Searches tweets with a reactive Convex-backed retrieval and ranking architecture.
- **Live app:** not deployed (SERP runs locally: `pnpm web`)
- **Repo:** https://github.com/Priyansh4444/xearch
- **Frontend:** `apps/web` (React 19 + Vite), local only
- **Convex deployment:** cloud dev deployment (team pc-style, project xearch), full corpus loaded
- **Components:** none
- **Convex features:** schema, indexes, full-text search, vector indexes, queries, mutations, actions
- **Auth:** none
- **AI models:** none
- **Started:** 2026-08-31T10:15:32Z
- **Last updated:** 2026-09-07T12:40:00Z

## Log

### 2026-08-31 - 903ce53
Scaffolded Xearch's search contracts, bounded retrieval plan, ranking engine, and
Rust ingestion pipeline. Added Convex tables and indexes plus query, mutation,
and action shells for search, feedback, ingestion, semantic rescue, and answer
mode (`convex/schema.ts`, `convex/search.ts`, `convex/ingest.ts`,
`convex/feedback.ts`, `convex/vector.ts`, `convex/answers.ts`).

### 2026-09-01 - a1211a4
Added project development rules and agent tooling. Installed the Convex skill
set and the hackathon build-log skill, then trimmed the skills lockfile and
unused skill configurations (`AGENTS.md`, `.agents/skills/`,
`.claude/skills/`).

### 2026-09-01 - 096cbfd
Documented collection sources: FxTwitter as the primary source, X syndication
as a partial fallback, Firecrawl as last-resort text recovery, plus repost
deduplication and checkpointed JSONL rules (`docs/COLLECTION.md`).

### 2026-09-01 - dd193d5
Switched the package manager to pnpm with a workspace file and updated the
docs to match (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`).

### 2026-09-01 - 84fb1db
Added agent workspace setup and resume scripts, aligned them with pnpm, and
committed the indexer's Cargo lockfile (`.agents/setup`, `.agents/resume`,
`indexer/Cargo.lock`).

### 2026-09-01 - 2622c48
Added the first resumable collection pilot: an FxTwitter client, a probe
library and CLI, pilot documentation, and probe tests
(`collector/fxtwitter.ts`, `collector/probe.ts`, `docs/collection/01-pilot.md`,
`tests/collector.probe.test.ts`).

### 2026-09-01 - 9b8e685
Moved the collector into `apps/collector` with `acquisition`, `cli`, and
`probe` modules, added the pilot config with its tests, and updated the
collection docs (`apps/collector/src/`, `config/collection/pilot.json`).

### 2026-09-03 - 0d88f0d
Built the full collection pilot: 62 configured accounts, resumable runs with
checkpoints and manifests, normalization into ingress records, archive
digests and verification, a pilot report with smoke thresholds, and gate-2
account discovery. Added a read-only Cloudflare Worker dashboard over the
`xearch-runs` R2 bucket (`apps/collector/src/pilot/`, `apps/dashboard/`,
`apps/collector/tests/pilot-run.test.ts`).

### 2026-09-03 - e1779c2
Fixed the project typecheck setup and tokenizer typing, kept the GitHub
account configuration local, and recorded the full pilot run results:
62 accounts, 6,105 requests, 164,959 accepted posts, archive verified
(`convex/engine/tokenize.ts`, `docs/collection/01-pilot.md`).

### 2026-09-03 - 2522d67
Replaced the dashboard home page with a minimal tabbed overview: posts
processed, authors, accounts, runs, quality, and storage, with a manual
Refresh button and a light/dark toggle. The full per-run page moved to
`/nerds` and a `/api/summary` endpoint feeds the overview. Investigated the
one failing pilot check (repeated timeline rows, 13.16% vs 10%): sampled raw
pages show the with-replies timeline re-serving identical posts as
conversation context, not a paging fault, so the bound was raised to 15% and
the decision documented (`apps/dashboard/src/overview.ts`,
`apps/collector/src/pilot/report.ts`, `docs/collection/01-pilot.md`).

### 2026-09-07 - cb2ff36
First usable search demo, end to end on the baseline lane. Implemented the
Rust tokenizer twin (scanner parity with `convex/engine/tokenize.ts`; the
shared golden fixture passes in both languages), `ingest.ingestBatch` with
idempotent author/tweet/posting/term/meta writes, the pipeline's
tweet-to-postings transform with deterministic static scores and log-spaced
buckets, and the checkpointed `backfill` loop with quarantine and ingress
sanity gates. Added `pnpm collect:pull` (read-only R2 pull, digest-verified
against the run manifest) and pulled `2026-09-03T06-45-44Z-full`. Loaded a
100-post slice, inspected rows, then backfilled all 164,959 posts and 22,811
authors into a cloud dev deployment: 0 quarantined lines, ~1,700 batches,
re-sent batches confirmed idempotent. Two operational fixes along the way:
Convex's 4,096-read mutation limit forced a per-batch df-term budget, and
ack numbers deserialize as floats. Built `apps/web`, a React 19 SERP over
`search.searchBaseline` (author-hydrated) with loading, empty, partial, and
error states, media rendering, literal-hit highlighting, and shareable
`?q=` URLs; verified demo queries (bun, pricing, rust, react server
components, agents) each return 20 real posts
(`indexer/src/tokenizer.rs`, `indexer/src/pipeline.rs`, `indexer/src/main.rs`,
`convex/ingest.ts`, `apps/web/`, `apps/collector/scripts/pull-run.sh`).

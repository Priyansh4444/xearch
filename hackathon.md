# Hackathon log

- **Project:** Xearch
- **Event:** Convex All Gas Hackathon
- **What it does:** Searches tweets with a reactive Convex-backed retrieval and ranking architecture.
- **Live app:** not deployed
- **Repo:** https://github.com/Priyansh4444/xearch
- **Frontend:** not deployed
- **Convex deployment:** not deployed
- **Components:** none
- **Convex features:** schema, indexes, full-text search, vector indexes, queries, mutations, actions
- **Auth:** none
- **AI models:** none
- **Started:** 2026-08-31T10:15:32Z
- **Last updated:** 2026-09-01T01:54:58Z

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

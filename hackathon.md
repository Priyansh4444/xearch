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
- **Last updated:** 2026-08-31T10:15:32Z

## Log

### 2026-08-31 - 903ce53
Scaffolded Xearch's search contracts, bounded retrieval plan, ranking engine, and
Rust ingestion pipeline. Added Convex tables and indexes plus query, mutation,
and action shells for search, feedback, ingestion, semantic rescue, and answer
mode (`convex/schema.ts`, `convex/search.ts`, `convex/ingest.ts`,
`convex/feedback.ts`, `convex/vector.ts`, `convex/answers.ts`).

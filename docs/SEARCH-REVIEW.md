# Search milestone review fixes

These changes are on `pcstyle/full-search-pipeline`, not deployed. The existing
cloud corpus and its statistics have not been repaired or reindexed.

## Ingestion and archive safety

- **1: Replay-safe DF.** `ingestBatch` computes term increments from newly
  inserted tweets. The client's `dfDeltas` field remains accepted for wire
  compatibility but is not applied. Whole-batch retries, overlap, and metrics-only
  updates cannot increment DF. Previously inflated production statistics still
  require an audited rebuild.
- **2: Config isolation.** The mutation checks `meta.activeConfig` before any
  write and rejects hash, tokenizer-version, or lexicon-version mismatches.
  Clearing a local checkpoint does not authorize mixing configurations.
- **10: Required archive files.** Pull verification requires report and ingress
  files plus their manifest digests. Missing or corrupt required files fail.
- **11: Trailing progress.** Backfill stores the final line offset after draining
  pending records, even when the suffix contains only blank or quarantined lines.
  Normal restart does not quarantine those lines twice. A crash between writing
  quarantine and storing the checkpoint can still repeat a rejection.
- **16: Authority preservation.** Replaying an existing real author preserves
  computed authority. Initial insert and stub upgrade initialize the follower
  fallback.
- **17: Weak aspects.** Both twins require an actual non-trigger content token,
  not repeated trigger words. The Rust config hash now includes `aspectMapping=2`.
  New ingestion must target a deliberately reindexed deployment; do not bypass
  the guard or delete the live corpus.

## Search semantics and bounds

- **3: RRF.** Union lists are fused before candidate truncation, so later lists
  can contribute. Prior eligible hits survive expansion.
- **4, 6, 12: Hard predicates.** A shared candidate-text predicate enforces
  negation, normalized phrase adjacency (including stopwords), author, time,
  media, likes, and language on every retrieval path before survivor counting.
  Time windows are `[since, until)`.
- **5: Input and work caps.** Public search rejects more than 512 characters or
  12 input tokens, and more than 12 indexed terms/aspects after parsing. At most
  5 PRF terms are added. Each term reads at most 500 postings, once per request,
  cached across ladder levels. Five levels each inspect at most 200 candidates;
  the final reranker sees at most 200. This is bounded approximate retrieval,
  not proof that an empty result means nothing exists in the full corpus.
- **7, 8: Latest.** Candidate timestamps dominate final ordering and dedup
  representative selection. Explicit `sort:` operators win over the separate
  sort argument; the UI disables conflicting tabs and explains why.
- **9: L1.** Only unprotected `must` terms can be dropped. Phrase/aspect gates
  cannot accidentally be removed by a high DF.
- **13: Provenance.** Each returned candidate keeps its earliest eligible ladder
  level, rather than inheriting the last global expansion level.
- **18, 19: UI state.** Query/sort/lane changes show loading instead of unkeyed old
  results. Invalid queries and unknown authors return actionable errors with the
  search input still available. Failed votes do not optimistically claim success.

## Feedback contract and rollout (14, 15)

`feedback.vote` requires `ctx.auth.getUserIdentity()`. The optional legacy
`sessionId` argument is accepted but ignored; the verified token identifier owns
the vote. `queryKey` must be a 16-character lowercase hex key, and the tweet must
exist. Duplicate votes are no-ops; flips atomically update the row and total.

Schema additions:

- Optional `searchFeedback.voterId`, indexed by `(queryKey, voterId, tweetId)`.
- `searchFeedbackTotals`, indexed by `(queryKey, tweetId)`, updated transactionally.
- `feedbackRateLimits`, indexed by voter, limiting changed votes to 30/minute.

Legacy anonymous votes remain stored, without being copied into trusted totals.
This intentionally resets their ranking influence, not their historical data.
Serving reads one exact total per candidate, with no 500-vote truncation.
The UI asks `feedback.canVote` and hides voting controls for anonymous users.
There is no new auth provider or sign-in flow in this change. Configuring one is
a separate product decision; multi-account abuse still depends on its controls.
Deploy schema and backend changes together before using this frontend build.

## Verification and limits (20)

`convex-test` exercises actual mutation/query handlers with isolated database
state: replay, overlap, config mismatch, authority, RRF, hard filters, phrases,
Latest, unknown authors, provenance, trusted feedback, 505 voters, and rate limits.
React/jsdom tests cover loading transitions, recoverable errors, hidden anonymous
controls, and failed/successful vote writes. The pull verifier runs against local
missing, complete, corrupt, and missing-digest fixtures.

Generated Convex bindings are committed so fresh-checkout typechecking is offline.
`pnpm codegen` is a separate regeneration step, requiring deployment access.
Rust tests cover tokenizer parity, repeated weak triggers, and running the actual
backfill binary twice on rejected/blank input without making network requests.

No live ingestion, live vote migration, cloud deployment, or R2 download was run
for these fixes. Browser coverage is DOM-based, not a deployed browser walkthrough.

# Search constraints and failure catalog

These are limits, not claims that every query finds the desired post.

| Case | Failure or constraint | Current rule and evidence |
| --- | --- | --- |
| `react cp,[o;er]` returns a CP virtual-machine post | Built-in full text can retrieve partial-token candidates | Baseline checks all meaningful literal tokens before returning a candidate. It may return zero rather than guess `compiler`. |
| `react compiler`, only `react` present | An OR-style or broadened retrieval leaks irrelevant posts | Baseline requires both terms. Experimental posting search still has a disclosed recall ladder. |
| `and so is` (all-stopword query) | The posting index has no entries for stopwords, so it cannot answer them | Baseline tokenizes the query with stopwords kept, retrieves them from the built-in full-text index (which indexes them) and still verifies every token. The posting lane shows no results and the SERP offers the literal lane. |
| Top in the baseline lane | Full-text retrieval exposes relevance order, not the corpus's best posts | Top ranks the verified candidate page with the shared deterministic ranker (`engine/rank.ts`); it is not a global ordering, and an exact match outside the bounded window stays out of reach. |
| Single-term query | Nothing exists to relax, so widening would answer a different question | The ladder never escalates a query with fewer than two distinct terms. Live evidence: `pronsh` widened at L3 into unrelated megaposts; it now returns the two exact posts. |
| Latest | Full-text retrieval exposes relevance order, not a global timestamp scan | Sort only the current bounded candidate page. UI explicitly states this limitation. |
| Rare term outside candidate window | Strict verification can remove every candidate even when later matches exist | The default query over-fetches 100 candidates. The web app can request later 20-candidate pages; no request is unbounded. |
| `height of theo` | A question about a person is not necessarily a request for posts by that person | Parser regression tests cover this distinction. Baseline stays literal. |
| Ambiguous spelling or names | Automatic correction can change intent | No baseline autocorrect. AI is opt-in and requires review before applying. |
| `from:`, dates, media, language, likes, phrases, exclusions | Rewriting must not erase explicit constraints | Safe interpretation accepts plain words only and preserves Tier A consumed syntax. No model-authored operators. |
| Unknown author or filter-only query | Silently dropping a filter would broaden results | Backend errors instead of scanning or ignoring constraints. |
| Interpretation provider timeout or invalid output | Original query must remain usable | No automatic invocation; timeout and malformed-response errors leave the original query unchanged. |
| Anonymous paid requests | An explicit click does not prevent automated abuse | Public interpretation is unavailable pending approved auth and quota policy. Internal preview is not a public bypass. |
| Bad-query feedback | Anonymous writes can create cost and store sensitive wording | Only trusted Convex identities can report; reports normalize and deduplicate by user, query and lane and share the feedback write limit. |
| Empty or inactive arrivals feed | A reactive database is not an external data source | Feed reads at most 20 arrival-ordered rows; ingest must supply real posts. No production test writes. |
| Old aspect postings | Parser/indexer fixes do not rewrite stored data | Existing corpus may contain weak-aspect postings; deliberate separate reindex remains required. |
| Client sees 3–5 seconds | Network, cold execution, reads, parsing and rendering may all contribute | Client timings cannot establish server time. No 20x claim, cache-cost claim or latency subtraction is evidence. |
| Cached date interpretation | Relative dates are not correct forever | Existing Tier C cache needs version/age policy before public paid enablement; new preview writes no cache. |
| Viral partial match beats quiet exact match | Engagement can dominate term coverage after L2 expansion — and after any widening | Both lanes now order Top with the same ranker, so the risk spans literal pages too. Characterization tests record it; do not change weights without the judged Recall@20/nDCG gate in `docs/RANKING-EVALUATION.md`. |

## Verification scope

Unit and integration tests use local fixtures. Read-only production benchmarks
measure the deployed code, not undeployed local changes. A provider fixture is
not a real LLM quality evaluation. No paid providers, production mutations or
destructive reindex are part of verification.

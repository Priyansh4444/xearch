# Ranking evaluation

This is the decision list for ranking changes. It separates observed behavior
from choices that need relevance judgments.

## Evidence collected

On 2026-09-10, a seeded shuffle selected 40 rows from the newest 400 production
documents in `sleek-emu-128`. This is a reproducible spot check, not a
representative corpus sample. The slice is heavy on replies and posts involving
the Convex account because ingestion time clusters related data.

The sample contained:

- high-engagement general posts next to low-engagement technical posts
- short replies whose useful context lives in a parent post
- mention-heavy comparisons and questions
- URL-only or emoji-only posts
- product incidents, release announcements, opinions, and support questions
- misspellings such as `codvex`

The sample generated generic parser cases in
`shared/fixtures/search-intent-cases.json`. No copied post text or personal data
is committed.

## Confirmed behavior

`tests/plan-rank.test.ts` records this result under the current weights:

```text
two-term quiet exact match < one-term viral L2 match
```

That test is a characterization, not an assertion that the order is desirable.
It makes the risk visible while the judged set is missing.

The literal baseline avoids this problem by requiring every meaningful token
after Convex full-text retrieval. Its tradeoff is different: an exact match
outside a bounded candidate page may require loading another page.

## Decisions that need judgments

### Should exact matches form a protected partition?

Option A ranks all L0 results before L1-L3 results. It gives clear semantics and
prevents engagement from beating exact coverage. It can bury an excellent
near-match under weak exact matches.

Option B keeps one score but adds a must-coverage or ladder-level feature. It is
more flexible and harder to reason about.

Recommendation: judge at least 30 queries before choosing. Start with an
exact-first partition because users can understand it, then keep it only if
nDCG@10 and qualitative failures improve.

### Should replies be penalized?

Many sampled replies have little standalone text. A blanket reply penalty would
also hide useful answers. Evaluate a context-quality feature instead:

- no penalty when the reply covers all query terms
- consider a penalty when most tokens are mentions and the query only matches a
  mention
- later hydrate the parent only for finalists if judged data shows enough value

Do not add a parent hydration read to every candidate.

### What should “Latest” mean?

The baseline can order one relevance page by `createdAt`; it cannot promise the
newest matching posts in the corpus. A true global Latest path needs a
time-ordered retrieval plan with lexical verification and a bounded scan.

The UI must say “Recent matches” until that path exists.

### Should spelling change retrieval?

No silent rewrite. Keep unknown words literal. A future “Did you mean?” may be
shown only when:

- the exact term has no dictionary row
- one indexed candidate is edit distance one away
- the candidate has a meaningful document frequency and dominates alternatives
- the token is not an operator, handle, hashtag, cashtag, URL, number, acronym,
  emoji, or mixed-script word
- the user applies the correction

The sampled `codvex` and fixture `conevx` remain literal today.

### Should popular posts precompute query intent?

No. Engagement is a ranking signal, not evidence of what future users mean.
Precomputing XQuery terms from popular posts would add ingestion writes and make
intent follow popularity. The aspect lexicon and optional user-requested
interpretation already handle vocabulary gaps without changing every query.

## Corrections landed without the gate

Two reported failure shapes were fixed as question-mismatch defects rather than
tuning choices, so they landed without the judged set below:

- A single-term query no longer escalates (`convex/engine/plan.ts`). The ladder
  unioned the term with itself, then PRF-mined the topic co-occurring in the few
  exact hits: `pronsh` returned @theo megaposts. The exact result set of one term
  is already complete. Guards: `tests/plan-rank.test.ts`,
  `tests/convex.integration.test.ts`.
- The literal lane's `Top` now orders its verified candidate page with the same
  deterministic ranker the posting lane uses (`convex/search.ts`). Built-in
  relevance order put a 2-like reply above a 316-like post for `waterfall`. This
  is an ordering-policy change without judged nDCG evidence; it stays scoped to
  the candidate page each request retrieves.

The gate below still applies before changing `WEIGHTS`, posting caps, or reply
treatment, and to any further ordering-policy change.

## Required gate

Before modifying `WEIGHTS`, ladder ordering, posting caps, or reply treatment:

1. Freeze 30-50 queries spanning exact terms, phrases, authors, comparisons,
   aspects, dates, typos, sparse results, and reply-heavy topics.
2. Pool candidates from baseline and L0-L3.
3. Judge each candidate 0-3 without seeing which lane produced it.
4. Report nDCG@10, Recall@20 against the pooled oracle, zero-result rate,
   candidate documents read, and latency by query shape.
5. Keep production examples that caused failures as generic regression cases.

Result-count floors are useful smoke tests. They are not recall measurements.

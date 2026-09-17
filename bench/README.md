# Bench suite (workflow playbook: perf-issue)

Composable correctness + speed benchmarks for xearch. Every part of the
pipeline is independently checkable; all numbers are device-relative (this
device is not the final server) — the harness exists so changes can be
compared across machines and time.

## Parts (each independently composable)

`tokenizer → parser (tierA+tierB) → planner (planL0/escalate) → executor
(postings reads) → reranker → serving (hydration, feedback, repair) → ingest
(ingestBatch + dfPending fold) → did-you-mean`

## Correctness (random sampling)

```sh
pnpm vitest run tests/bench-correctness.test.ts
```

Seeded (reproducible) random sample of the REAL corpus
(`data/old/*/ingress/records.jsonl`, sampled in `bench/corpus.ts`) plus
generated queries. Invariants, one group per part:

| part | invariant |
| --- | --- |
| ingest | idempotence: replaying an ingestBatch inserts 0 and changes no counts |
| df | conservation: `terms.df` == number of postings rows for sampled terms |
| executor/rerank | L0 exactness: every `matchedVia: L0` result contains every query term |
| serving | pagination: the echoed `nextPrefix` prefix re-appears pinned in order on page 2 |
| repair | did-you-mean: a df-0 typo offers the edit-distance-1 term |
| parser | filters internally consistent; unknown-author error is an invariant (P1: never guess) |

## Speed

```sh
pnpm vitest run tests/bench-speed.test.ts        # offline per-part CPU timings
BENCH_PROD=1 pnpm vitest run tests/bench-speed.test.ts  # + prod e2e latency
```

Per part: tokenizer, parser, planner, rerank (200-candidate window), repair.
Discipline: 3 warmups, ≥5 trials, an A/A control in the same run (the noise
band is printed next to the median), medians + p95.

Latest measured (2026-09-17, this device): parse ~60µs/query, planL0 ~108µs,
rerank(200) ~310µs, repair ~6µs; prod e2e p50 ~0.5-1.6s, p95 ~4.1s (network
round trips from this device; the Elasticsearch lane is ~20-25ms local, see
docs/SECOND-SOURCE.md).

## Compose

Each part is independently benchable: the invariants live in separate vitest
tests (drop into any subset), and the timing harness (`timePart`) is generic —
add a part by writing one `timePart("name", calls, fn)` line. The corpus
sampler (`bench/corpus.ts`) is seeded, so a sampled run is reproducible and
comparable across devices; change the seed for a different sample.

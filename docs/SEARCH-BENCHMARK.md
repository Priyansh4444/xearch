# Search benchmark audit

## Result

The deployed search reproduced multi-second requests. Immediate repeats were much faster. This does not demonstrate a code speedup, server execution under 50 ms, or Recall@20.

Eight read-only HTTP query calls ran against `https://sleek-emu-128.convex.cloud` on 2026-09-10, from 06:41:13 through 06:41:34 UTC. No mutation, action, deployment, cache invalidation, or paid model call ran. Each call used `search:search`, `sort: "top"`, and the raw query below.

| Query | First observed ms | Immediate repeat ms | Results | Ladder | Query key |
| --- | ---: | ---: | ---: | --- | --- |
| `bun` | 6935.116 | 103.364 | 20 | L0 | `8d1c76acf19d1b87` |
| `convex` | 4654.207 | 100.381 | 20 | L0 | `67ec4b8c9627a061` |
| `react server components` | 499.296 | 87.856 | 20 | L0 | `71fff2189b58ba84` |
| `rust vs go` | 8707.367 | 152.450 | 20 | L1 | `a1477d029f0e1b05` |

Each pair returned identical response bytes and ordered IDs. Every response had `error: null` and `refined: null`. All eight historical count floors passed. The four first-observed samples had nearest-rank p50 4654.207 ms and p95 8707.367 ms. The four repeats had p50 100.381 ms and p95 152.450 ms. Four samples per group are descriptive observations, not a reliable production percentile estimate.

## Follow-up baseline observation

Four additional read-only requests to `search:searchBaseline` ran on 2026-09-10 from 12:01:54 to 12:01:56 UTC, using only `{ raw }` arguments. This was a separate process and a later observation, not a paired before/after experiment. HTTP status was 200 and Convex status was success for all four. Deployed revision/configuration and cache status remained unknown.

| Query | First observed ms | Immediate repeat ms | Results |
| --- | ---: | ---: | ---: |
| `bun` | 1084.416 | 92.502 | 20 |
| `convex` | 731.674 | 83.599 | 20 |

Both baseline pairs returned identical response bytes within the pair. SHA-256 for `bun` was `fcc81d5b557f87e320c8071f9a201ba61c8f1a6ead4bdee763fb8d22c5214412`; for `convex` it was `4a8194e4653decf3a28508998ea46216303ad5db24767946ac4ec64663615f58`.

Ordered baseline source IDs:

```json
{
  "bun": ["2035273966387175649","2055826051033600379","2082510166323331507","2078694155124134295","2089206432650625259","2095072716198183214","2030748088529310201","2085868902018691257","2087451245325750328","2089872983179571381","2085422285842989307","2057587641277984935","2050283954549235776","2071782393451782642","2049466654229442786","2049459381742522758","2087442882202591358","2044710630964510896","2068701644838277426","2074969942018138500"],
  "convex": ["2055828667687911510","2023863743365738975","2031185377055125641","2088661022076780972","2093552681256399338","2047959261024514239","2086963785403871733","2051369893627621602","2081829107751670096","2082675621025714567","2031988124394663937","2086244235989442922","2093460647384351140","2043872828403945749","2070212095027904954","2073188743293571202","2082584640515412222","2086216102334636418","2080971864730452231","2095254375971291187"]
}
```

These baseline timings were lower than the earlier posting-lane observations for those two queries, but the result IDs and ranking differ. They do not establish the requested 20x gain, equivalent relevance, browser latency, or the performance of newly edited baseline code. Total production traffic for this audit was 12 read-only queries.

## Post-deploy observation

After deploying bounded candidate hydration and concurrent independent reads on
2026-09-10, the same four posting-lane queries ran twice:

| Query | First observed ms | Immediate repeat ms |
| --- | ---: | ---: |
| `bun` | 814.8 | 95.2 |
| `convex` | 374.9 | 99.5 |
| `react server components` | 782.6 | 91.0 |
| `rust vs go` | 1740.8 | 94.6 |

First-observed p50 was 782.6 ms and repeat p50 was 94.6 ms. The production
smoke run also confirmed that `height of theo` parsed as a question about Theo
without an author filter, the malformed compiler query returned no baseline
results, pagination returned a continuation cursor, and the arrival feed
returned 20 rows.

This is not a controlled before/after experiment. Deployment, process,
connection, and cache conditions differed, so ratios against the earlier table
cannot be attributed solely to the code change. The result does show that the
reported multi-second path still exists for some first requests and that the
requested universal 20x improvement has not been established.

## Post-fix observation (2026-09-10)

After deploying the all-stopword and single-term-widening fixes (`fbdfbf55`), the
read-only harness ran once over all 14 fixture queries (`--runs 1 --limit 14`, 14
requests to `https://sleek-emu-128.convex.cloud`). Every result-count floor
passed; single-term queries stayed at L0 and multi-term queries still escalated
(`rust vs go` L1, `what did karpathy say about llm agents` L3 with 18 results).
First-observed p50 was 634 ms and p95 1290 ms over 14 samples — client-observed
HTTP time, not server execution, and not a controlled comparison against the
earlier tables.

The three reported query shapes were also checked directly through the same
public API, read-only and without cache-busting:

| Query | Lane | Before | After |
| --- | --- | --- | --- |
| `and so is` | baseline | threw `Add a search word or quoted phrase alongside filters.` | 19 verified posts, engagement-ordered |
| `pronsh` | xearch | L3, widened into unrelated @theo megaposts | L0, exactly the 3 posts containing the token |
| `waterfall` | baseline | built-in relevance order: a 2-like reply led and the 316-like post was ninth | 316-like post first, then 71 / 52 / 21 / 59 |

Each row is one observation, not a recall or nDCG measurement.

## What the measurement means

- Timing starts before HTTP fetch and stops after reading the response body. It includes connection setup, network, service processing, and body transfer. It excludes JSON parsing and browser rendering.
- "First observed" means first in this process, not a proven uncached execution. "Repeat" means identical request arguments, not a verified cache hit. No server execution or cache-hit telemetry was available.
- The fast repeats and identical bytes are consistent with Convex query caching. Connection reuse and other runtime effects can also change latency. The benchmark cannot allocate time to those causes.
- The previous script discarded two calls per query before measuring eight repeats. That hid the path most likely to expose the reported delay. Its default also sent 140 requests over 14 queries, rather than a low-volume diagnostic.
- Subtracting an empty-query "network floor" from another query cannot isolate server execution. The two requests may take different cached paths and have different transfer costs. Remove the previous "single-digit–20 ms server-side" and "well under 50 ms" claims.
- A 20x reduction from 3–5 seconds would mean 150–250 ms for the same workload and timing boundary. Comparing a first request with its cached repeat is not evidence that new code reached that goal.
- Returning 20 IDs is not Recall@20. Even 20 unrelated documents pass a count floor. Recall needs a fixed corpus, judged relevance or an explicit uncapped oracle, and ID comparisons. None was available in this audit.
- This HTTP measurement does not cover browser debounce, WebSocket subscription startup, rendering, or Tier C. The four posting query shapes and two baseline queries do not establish performance of author, phrase, negation, date, or aspect queries.

## Revision and configuration provenance

The local checkout was dirty at `5e6fdd6dbb518d6be05b348a49c85b8679f5866a`, with concurrent, undeployed edits. The query API did not expose a deployed revision, corpus snapshot ID, or deployed index configuration hash. Those fields remain unknown; the local revision is not evidence of deployed code. No new search implementation was deployed or measured here.

The observer ran Node `v26.8.1`, two sequential calls per query, four queries in fixture order, no warmups, no retries, and a 30-second per-call timeout. No authentication was supplied.

Local file SHA-256 at measurement time:

- Query fixture: `19110196809a945ba708cb7c4bcced0b204cadde262581a4ecf079025c3c1392`
- Aspect lexicon: `8bdfe351eb1db068e2f00783115aa48499d0cb9453322112cf99e97ff1368b37`

The fixture's misleading comment was corrected after this measurement, so its current hash differs. Query text and floors were not changed. These local hashes do not identify the deployed index.

Response body SHA-256, identical for both calls in each pair:

| Query | SHA-256 |
| --- | --- |
| `bun` | `8b628a1edeeb0a863c0070ea423da34aeb7888d2e26358fd0e614318b65f38d7` |
| `convex` | `74339929360270f5f04ee5bb2f778cb04e317d6e15167bb73cab580b984aff60` |
| `react server components` | `6d87b49e88f22368efb53e1f88fe36dfa54e82d1af0a8c947d21a57971e49be2` |
| `rust vs go` | `96b97d0c5b1d6bf787e8e6edd95ed8fadc58739110bae619c0f5b55ea18d4c46` |

Ordered source tweet IDs, captured rather than inferred from result counts:

```json
{
  "bun": ["2055039647924007222","2090443675063263738","2075576990271262938","2039223219102859302","2050421589150404826","2054412812878033309","2053063524826620129","2074973674332123157","2058803457902125410","2055669487517790365","2073612942743146740","2090943847748833526","2048857521243504708","2088592968966107556","2076912657400221811","2088964470148313158","2067892484009824536","2039168928145109343","2051197541174440376","2054004012463387130"],
  "convex": ["2041963744503480422","2075052834324955511","2061872764298944665","2084752809476456820","2086807731625947534","2088416215203295346","2082251052246814845","2049976855617314991","2086608455155294682","2079615401936519324","2085826060935946354","2062011135797137776","2084660523011072377","2078260461775028581","2092354976395956424","2085170239994536034","2067610012466167832","2092328530780774894","2082524246979510508","2077149173519110563"],
  "react server components": ["1999217365628903739","2046788389937000576","2043725484446601429","2052467567588196703","2025866496564474090","2080017449575965181","2090068164860117058","2072247353973891314","2081664508720795777","2090144110418293009","2087933704819949783","2092156452400234779","2070888120216916052","2084610239811481819","2092598537565634582","2063301009217400908","2087923605393043556","2094319943638827507","2078510562682789930","2081613629766697209"],
  "rust vs go": ["2052528426209460342","2056585640456618275","2069865219938029884","2087604711767896527","2041578392852517128","2065775883902652683","2071323738201837785","2085019794336530853","2095013326669463702","2082055442751234215","2048602588749468078","2041722116316524603","2061343035812728945","2072673187666813226","2065532079744668008","2078500037735174229","2055491938464489888","2081330224000606410","2080028403789385976","2070555274835046430"]
}
```

## Reproduce without disguising cache effects

```sh
CONVEX_URL=https://sleek-emu-128.convex.cloud \
  node scripts/bench-search.ts --runs 2 --limit 4 > search-observations.json
pnpm exec vitest run tests/bench-search.test.ts
```

The script emits JSON with each observation, ordered result IDs, response hashes, query keys, local provenance, and separate first-observed/repeat summaries. Defaults send eight requests. It rejects invalid counts and more than 100 total requests. It never adds random cache-busting terms, calls actions, or retries. A count-floor or request failure sets a nonzero exit code; it is a smoke failure, not an automatic recall verdict.

For a before/after claim, record the deployed revision and index configuration from trusted deployment metadata, keep the same corpus and query set, and compare like-for-like cache conditions. Use server logs or supported execution metrics to measure server time and database reads. Obtain uncached measurements in a controlled deployment rather than forcing production invalidations. Measure the actual browser flow separately. Keep the correctness oracle separate from timing.

## Rust and cargo-nextest

Existing Criterion benches in `indexer/benches/tokenizer.rs` and `indexer/benches/pipeline.rs` measure tokenizer work and offline `BatchBuilder::push_tweet` throughput. The pipeline bench uses eight synthetic texts and drains an in-memory batch. Neither bench makes search requests or measures Convex query execution.

`cargo nextest --version` failed on this machine because the subcommand is not installed. No Rust benchmark was run in this audit. Once available, `cargo nextest run --manifest-path indexer/Cargo.toml` runs Rust correctness tests; `cargo bench --manifest-path indexer/Cargo.toml` runs the Criterion benchmarks. Nextest is a test runner, not a replacement for those timing benchmarks.

Porting this small HTTP observer to Rust would not make deployed TypeScript queries faster or remove caching bias. Keep it in TypeScript beside the query fixtures. Use the existing Rust benches for indexer performance, and only add a Rust offline search oracle when its corpus and ranking contract are specified.

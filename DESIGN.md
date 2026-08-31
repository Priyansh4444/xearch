# Xearch — Spec (v3, final)

A search engine for tweets, built on Convex. Rust does ingest/tokenize/score offline;
Convex stores **all serving state**, understands queries, ranks, and streams results
reactively to a React 19 frontend.

Companion documents — this file is the *what/why*; these are the *how*:

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module map, contracts between components, design rationale + alternatives |
| [docs/RISKS.md](docs/RISKS.md) | What can go wrong, and the compromise we take for each |
| [docs/ASPECTS.md](docs/ASPECTS.md) | Aspect-token difficulties, how the field solves them, our position |
| [docs/PARSER.md](docs/PARSER.md) | Tier C made concrete: JSON Schema, prompt, grammar, eval protocol |
| [docs/INGRESS.md](docs/INGRESS.md) | Data-collection contract: JSONL schemas, collector rules, corpus shaping |

Two invariants govern every choice below:

1. **Speed.** The rules-only path (parse → retrieve → rank) is one reactive Convex
   query: target p50 ≤ 50 ms server-side. Anything slower (LLM parse, vector search)
   runs async and *upgrades* the page via reactivity; nothing blocks first results.
2. **Correctness with a recall floor.** Operators are never reinterpreted and filters
   are exact — but a query never comes back empty while anything semi-relevant
   exists. A five-level relaxation ladder (§5.2) guarantees it, and relaxed results
   are labeled "related" rather than passed off as exact.

The pipeline, end to end:

```
raw query ─▶ Loose Parser (§4): A rules ▸ B lexicons ▸ C LLM ─▶ canonical XQuery IR
                                      │
                          ┌───────────┼──────────────┐
              lexical retrieval + recall ladder (§5)   vector retrieval (§11)
                          └───────────┬──────────────┘
                         RRF fusion + rerank (§6) ◀── user feedback (§6.3)
                                      │
                        ┌────────────┴────────────┐
                  results page (reactive)      AI answer mode (§10)
```

## 0. TL;DR decisions

| Decision | Choice | Why |
|---|---|---|
| Trie? | **No literal trie.** Ordered Convex index on `term` + range query | A B-tree index over sorted strings gives identical prefix semantics with 1 range read instead of O(depth) doc reads |
| Core structure | **Inverted index**: one posting doc per `(term, tweet)` | AND = postings intersection, O(matches) not O(corpus) |
| Filters (author/date/media) | **Denormalized onto posting rows**, compound indexes | Filter pushdown into the index; no post-scan filtering |
| Query understanding | **3-tier Loose Parser** (operator grammar → rule/lexicon annotator → LLM fallback), all emitting one canonical `XQuery` IR | Normalizes the million phrasings of a request into one executable form: `"elon on mars last week"` ≡ `mars from:@elonmusk since:7d` |
| Tier C hosting | Hosted structured-output model for the hackathon; distilled 1.5–3B + grammar-constrained decoding as the self-host path | Guaranteed-valid IR either way; full research in §4.4 |
| Recall floor | **5-level relaxation ladder**: exact AND → drop-term → OR/RRF → PRF expansion → semantic vectors | "Even something semi-relevant should show up" — with every level bounded (§5.2) |
| Vocabulary gap (`cheap` vs "outrageous pricing") | **Aspect tokens** in the inverted index + tweet-text embeddings | Attribute-level intent matched at lexical speed; embeddings catch the unlisted rest (§4.6, §11) |
| Ranking | **Two-phase**: impact-ordered retrieval, then rerank top ~200 with BM25 + quote-weighted engagement + Tweepcred-style authority + recency + feedback | Full-fat scoring only on candidates that can win (§6) |
| User feedback | Per-result 👍/👎 keyed by canonical `queryKey` | Rocchio-lineage relevance feedback, rerank-only boost, future LTR labels (§6.3) |
| Engagement churn | Postings carry a **quantized score bucket**; live counts read only at rerank | Don't rewrite the index every time someone likes a tweet (Earlybird's Feature Update Service lesson) |
| Common-word blowup | Impact-ordered posting caps + rarest-term-first intersection | Bounded reads per query (Convex caps ~16k docs/query); same family as MAXSCORE/WAND/Block-Max WAND |
| Hackathon storage | **Convex only** — every byte of serving state | One system to operate; the Earlybird-style archive tier is a labeled roadmap seam, not a dependency (§9) |
| Images | CLIP/SigLIP embeddings + Convex `vectorIndex`, fused with lexical via **RRF** | In scope now, not later (§11) |
| AI answers | Retrieval-grounded summarization in an action, streamed into a table the UI subscribes to | Mode 2 of the same pipeline, not a separate product (§10) |
| Baseline / fallback | Convex built-in `searchIndex` (Tantivy-backed BM25, prefix on last term) | Ship day 1, benchmark our index against it |

## 1. Why not "SQL for tweets with a massive AND clause"

A filter-scan model reads every candidate tweet and checks predicates: cost grows with
corpus size, not result size. Convex also hard-caps a query at ~16,384 documents /
8 MiB scanned, so a scan model stops working at exactly the moment the demo corpus gets
impressive. An inverted index reads only postings for the query terms.

## 2. Convex schema

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tweets: defineTable({
    tweetId: v.string(),          // X id, idempotency key for ingest
    authorId: v.string(),
    authorHandle: v.string(),
    text: v.string(),
    createdAt: v.number(),        // ms epoch
    likeCount: v.number(),
    retweetCount: v.number(),
    replyCount: v.number(),
    mediaType: v.union(           // filterable metadata
      v.literal("none"), v.literal("image"),
      v.literal("video"), v.literal("gif")),
    mediaUrls: v.array(v.string()),
    quoteCount: v.number(),
    // conversation-graph edges: fuel Tweepcred (§6.2) + boost propagation
    quotedTweetId: v.optional(v.string()),
    retweetOfTweetId: v.optional(v.string()),
    inReplyToTweetId: v.optional(v.string()),
    lang: v.optional(v.string()),
    tokenCount: v.number(),       // doc length, for BM25
    staticScore: v.number(),      // raw static score from the indexer (see §6)
  })
    .index("by_tweetId", ["tweetId"])
    .index("by_author_time", ["authorId", "createdAt"])
    // Fallback/baseline: Convex built-in full-text search.
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["authorId", "mediaType"],
    }),

  // One doc per (term, tweet). This IS the inverted index.
  postings: defineTable({
    term: v.string(),
    tweetId: v.id("tweets"),
    tf: v.number(),               // term frequency in this tweet
    // ---- denormalized for filter pushdown + scoring without a join ----
    authorId: v.string(),
    createdAt: v.number(),
    mediaType: v.string(),
    scoreBucket: v.number(),      // quantized 0..255 static score (see §6) —
                                  // NOT the live engagement number
  })
    // top-k by quality:   term == X, ordered by scoreBucket desc
    .index("by_term_score", ["term", "scoreBucket"])
    // recency mode:       term == X, ordered by createdAt desc
    .index("by_term_time", ["term", "createdAt"])
    // filtered search:    term == X AND author == Y, ordered by time
    .index("by_term_author_time", ["term", "authorId", "createdAt"])
    .index("by_term_media_score", ["term", "mediaType", "scoreBucket"])
    // deletes/edits: find all postings of a tweet
    .index("by_tweet", ["tweetId"]),

  // Term dictionary. Doubles as the "trie" for typeahead and gives df for planning.
  terms: defineTable({
    term: v.string(),
    df: v.number(),               // document frequency (updated by indexer)
  })
    .index("by_term", ["term"]),  // ordered => prefix range = trie walk

  // Author registry: filter target, entity-linking target, authority signal.
  authors: defineTable({
    authorId: v.string(),
    handle: v.string(),           // lowercase, no @
    displayName: v.string(),
    nameTokens: v.array(v.string()), // tokenized displayName for entity linking
    followerCount: v.number(),
    followingCount: v.number(),
    verified: v.boolean(),
    authority: v.number(),        // day 1: log1p(followers); then Tweepcred PageRank (§6.2)
  })
    .index("by_authorId", ["authorId"])
    .index("by_handle", ["handle"]),

  // Loose Parser Tier C cache: raw query -> canonical IR (see §4).
  queryCache: defineTable({
    normalizedRaw: v.string(),    // trimmed/lowercased raw query
    ir: v.string(),               // JSON-serialized XQuery
    source: v.union(v.literal("rules"), v.literal("llm")),
  })
    .index("by_raw", ["normalizedRaw"]),

  // Image/media embeddings (see §11).
  mediaEmbeddings: defineTable({
    tweetId: v.id("tweets"),
    mediaUrl: v.string(),
    embedding: v.array(v.float64()),
    createdAt: v.number(),
  })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,            // SigLIP base; 512 if CLIP ViT-B/32
      filterFields: ["createdAt"],
    }),

  // Tweet-text embeddings for semantic recall (ladder L4, §5.2 / §11).
  tweetEmbeddings: defineTable({
    tweetId: v.id("tweets"),
    embedding: v.array(v.float64()),
    createdAt: v.number(),
  })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 384,            // bge-small-en-v1.5 / MiniLM-L6 class
      filterFields: ["createdAt"],
    }),

  // Explicit relevance feedback: 👍/👎 on results (see §6.3).
  searchFeedback: defineTable({
    queryKey: v.string(),         // hash of canonical XQuery IR
    tweetId: v.id("tweets"),
    vote: v.number(),             // +1 | -1
    sessionId: v.string(),        // dedupe: one vote per session per (queryKey, tweet)
  })
    .index("by_query_tweet", ["queryKey", "tweetId"])
    .index("by_tweet", ["tweetId"]),

  // AI answer mode output, streamed + cached (see §10).
  answers: defineTable({
    queryKey: v.string(),         // hash of canonical IR
    status: v.union(v.literal("pending"), v.literal("streaming"), v.literal("done")),
    text: v.string(),
    citedTweetIds: v.array(v.id("tweets")),
  })
    .index("by_query", ["queryKey"]),
});
```

Notes:

- **Posting-per-document, not posting-list-per-document.** Convex arrays cap at 8192
  elements and docs at 1 MiB; a popular term overflows a list doc immediately. Millions
  of tiny docs behind a compound index is the shape Convex is good at.
- **Denormalization is the whole trick.** `authorId`/`createdAt`/`mediaType`/
  `scoreBucket` live on each posting so `from:user since:2024 has:image` never touches
  the `tweets` table until final hydration of the top ~20 results.

## 3. The "trie": prefix search over the term dictionary

```ts
// typeahead / prefix expansion — an index range scan is a trie descent
const matches = await ctx.db
  .query("terms")
  .withIndex("by_term", (q) => q.gte("term", prefix).lt("term", prefix + "\uffff"))
  .take(10);
```

Same asymptotics as a trie (the B-tree descends by shared prefixes internally), one
round trip, zero custom data structure maintenance. Use it for:

1. **Typeahead** in the search box (reactive Convex query — free live updates).
2. **Last-term prefix expansion**: while the user types `convex hackat`, expand
   `hackat` to its top-df completions and search those.

### Why not 26 tables (`terms_a` … `terms_z`)?

Splitting by first letter is a *manual, one-level* partition of the keyspace. A B-tree
index is the same idea applied **recursively at every character position**, maintained
automatically: the root node of the index already fans out by leading bytes, the next
level by the bytes after that, and so on. So the a–z split buys zero lookup speed —
Convex descends to the `t→ta→taj` subtree in the same logarithmic hops either way —
and it costs real things: 26 copies of every query/mutation code path, no single range
scan across letters, wildly uneven shards (`s` and `t` are huge, `x` is empty), and
non-letter first characters (`#hashtag`, `日本語`, digits) need a 27th junk drawer.
One table + one ordered index is the same data structure you were designing, minus the
bookkeeping.

## 4. The Loose Parser: query understanding

**Goal:** the million surface forms of a request normalize to one executable canonical
form — your `height of taj mahal → height(taj_mahal)` idea, generalized.

In a knowledge engine the *function name* is where meaning concentrates: `height(…)`,
`age(…)`, `distance(…,…)` are different questions. In a tweet engine every request
bottoms out in the **same** function — `search(…)` — so all of the meaning moves into
the **slots**. Normalization here means slot extraction, not function selection:

```
"elon tweets about mars last week"
"what has elon musk been saying about mars"      ─┐   search(
"mars from:@elonmusk since:7d"                    ├─▶   must   = [mars],
"mars stuff by elon recently"                    ─┘     author = 44196397,  ◀ id, not string
                                                        since  = now-7d)
```

Note `author = 44196397`, not `"elon"` — the exact analog of `taj mahal → /id/t191`:
surface strings resolve to **canonical ids** (§4.3), so caches, feedback, and ranking
all agree on what a query *means* no matter how it was typed. The taj mahal query
itself has an analog here too: `"height of taj mahal"` against a tweet corpus becomes
`search(must=[taj, mahal], aspects=[~spec], intent=question)` — the *attribute* the
user wants (`height`) survives as structure, not as a stopword.

The hard part is that meaning hides in different places per phrasing. Cases the parser
must normalize (worked results in §4.5):

- **Attribute/aspect requests:** `linux box cheap` isn't about the literal token
  `cheap` — it's about the *price aspect* of linux-box tweets (§4.6).
- **Comparatives:** `cybertruck vs rivian` → `must=[cybertruck, rivian]`,
  `intent=compare` — both entities required, "vs" is glue.
- **Multi-entity:** `what did sama and karpathy say about gpt-5` → two author-linked
  sub-queries, unioned, one topic.
- **Event anchors:** `during the openai board drama` → a topic *plus an implied date
  window* (Nov 17–22, 2023). Only Tier C can resolve arbitrary events — and the cache
  means each event is resolved once, ever.
- **Negation:** `apple tweets not about the iphone` → `exclude=[iphone]`.

This is the industry-standard three-layer query-understanding stack (normalize →
annotate → reformulate; cf. Tunkelang's framework and LinkedIn's unified QU work),
sized for a hackathon.

### 4.1 The canonical IR: `XQuery`

Every tier emits the same structure. Retrieval consumes **only** this — nothing
downstream ever sees the raw string:

```ts
type XQuery = {
  v: 1;
  intent: "topic" | "person" | "person_topic" | "media" | "question" | "event";
  must: string[];        // AND terms, tokenized identically to the indexer
  should: string[];      // soft expansions: completions, synonyms, #hashtag variants
  phrases: string[][];   // exact adjacency groups from "quoted strings"
  exclude: string[];     // -term
  filters: {
    authorId?: string;
    since?: number; until?: number;   // ms epoch, resolved from relative dates
    media?: "image" | "video" | "gif";
    minLikes?: number;
    lang?: string;
  };
  aspects: string[];     // canonical aspect tokens (`~price`, …) — §4.6
  sort: "top" | "latest";
};
```

Deliberately **absent** from the IR: presentation mode (list vs AI summary). That is a
UI choice the user makes, carried *beside* the IR in the request envelope — never
inferred. `intent: "question"` only nudges ranking and lets the UI *offer* a
"Summarize these?" chip; it must not flip modes on its own. Predictability beats
cleverness at the moment results render.

The IR is serializable, hashable (→ `queryKey` for answer/query caches), and loggable
(→ future learning-to-rank training data). **The IR is the API between "understanding"
and "retrieval"; each side can be improved without touching the other.**

### 4.2 Tier A — deterministic operator grammar (always runs, ~0 ms)

Classic operators, parsed with a tiny tokenizer in the query function:
`from:@handle`, `since:/until:` (absolute or `7d`), `has:image|video|gif`,
`min_likes:100`, `"exact phrase"`, `-excluded`, `sort:latest`. Power users and the
UI's filter chips speak this directly. If Tier A consumes every token, we're done —
no intelligence needed.

### 4.3 Tier B — rule + lexicon annotator (always runs, ~1 ms, no ML)

Operates on the tokens Tier A didn't consume:

- **Entity linking (people):** try token n-grams against `authors.by_handle` and
  `nameTokens` — `"elon"` → `authorId:44196397`. This is the `taj_mahal → /id/t191`
  canonicalization step: names resolve to ids, not strings. Ambiguity rule: link only
  if the top candidate's authority dominates (e.g. 10× next); otherwise leave as a
  `must` term.
- **Temporal lexicon:** `today`, `yesterday`, `last week`, `in 2023`, `since june` →
  `since/until`. A ~30-pattern table covers the long tail surprisingly well.
- **Media lexicon:** `pics|photos|screenshots of` → `media:image`; `video|clip` →
  `media:video`.
- **Intent-word stripping:** `tweets about`, `show me`, `what did X say about` are
  glue, not content — they set `intent` and vanish from `must`. This single rule fixes
  most "natural language queries return garbage" failures, because glue words are
  exactly the ones with huge df and zero signal.
- **Aspect mapping:** attribute vocabulary (`cheap`, `overpriced`, `fast`, `buggy`)
  maps to canonical aspect tokens (`~price`, `~perf`, `~quality`) — the full
  mechanism, and why it solves the "cheap vs expensive" problem, is §4.6.
- **Question detection:** interrogative shape (`what/who/why … ?`) →
  `intent:"question"`, offer answer mode.
- **Spelling repair:** unmatched token with df ≈ 0 → try edit-distance-1 neighbors
  against high-df terms (generate deletes/transposes, probe `terms.by_term`).

### 4.4 Tier C — LLM semantic layer (async, cached, only when needed)

Trigger: leftover tokens Tier B couldn't classify **and** the query looks like prose
(≥4 words, no operators), or the user hits "didn't find it?". Runs in a Convex
**action**; output is written to `queryCache` keyed by the normalized raw string, so
each phrasing pays the LLM cost **once ever**.

One call returns three things (a single JSON object, schema-enforced):

1. **The parse**: the `XQuery` IR — slots, entities, dates, intent.
2. **Expansions** (this is where recall gets rescued):
   - 3–5 **paraphrase queries** ("multi-query retrieval"): each runs through the same
     retrieval, and the lists are RRF-fused. Fixes vocabulary spread — the tweet says
     "login sequence", the user said "auth flow".
   - ≤8 **synonym/related terms** into `should` for the lexical side.
   - Fresh **aspect mappings** for attribute words the §4.6 lexicon doesn't list yet
     (they accrete into the lexicon file over time).
3. **A HyDE document**: a one-sentence *hypothetical tweet that would answer the
   query*, embedded for the vector side (§11). Queries and tweets are shaped
   differently in embedding space; matching tweet-against-tweet beats
   question-against-tweet (Gao et al. 2022).

**Progressive enhancement, powered by Convex reactivity:** the page renders Tier A+B
results instantly; when Tier C lands a richer IR, the reactive query re-runs and
results visibly upgrade in place. No spinner, no blocking on the LLM.

Why tiers instead of "LLM parses everything": latency (200–800 ms and a network hop vs
microseconds), cost at QPS, and determinism (operators must never be reinterpreted
creatively). The LLM handles exactly the residue rules can't — which is also the only
place it adds value.

#### Hosting options, researched

| Option | Latency | Quality | Verdict |
|---|---|---|---|
| Hosted small model with native JSON-schema mode (Gemini Flash / gpt-4o-mini / Haiku class) | 200–800 ms | High; schema mode makes malformed output a non-issue | **Hackathon default.** Zero infra, one env var |
| Self-hosted quantized SLM (Qwen2.5-1.5B/3B-Instruct class) via llama.cpp/Ollama + **GBNF grammar** | 30–150 ms on modest hardware | Mid; grammar guarantees *shape*, few-shot prompt carries semantics | Stretch goal; also the "we host our own parser" flex |
| **Distilled fine-tune**: big model generates synthetic (query → IR) pairs from our schema, LoRA onto a 1.5–3B base | sub-300 ms reported, with ~99.5% valid-JSON rates and 80–90% latency/cost cuts vs hosted | High *on this narrow task* | The correct endgame; post-hackathon |
| Zero-shot NER (GLiNER class) feeding Tier B | ~10 ms | Entities only, no slot logic | Optional Tier B upgrade, not a Tier C replacement |

**The key mechanic — constrained decoding.** Don't *ask* a small model for JSON;
*forbid* everything else: at each decode step the runtime masks tokens that would
violate the grammar (`logits[invalid] = -∞`). llama.cpp does this via GBNF; Outlines
compiles JSON Schema → FSM; XGrammar (vLLM) precomputes masks for the ~99% of tokens
whose validity is context-free, cutting masking overhead ~80×. Overhead is ~8–15% for
a sane grammar. Below ~13B parameters this is the difference between "usually valid"
and "always valid" — non-negotiable for a self-hosted parser.

**Honest caution on tiny models:** on *open-ended* structured generation (full
text-to-SQL), heavily quantized 1.5B models crater (BIRD EX drops from 63 at 32B to
~14 at 1.5B/Q4). Our task is far narrower — fixed slots, closed enums, short outputs —
which is exactly where small models hold up, but the lesson stands: **3B at Q5+ over
1.5B at Q4, always with the grammar, never trusted without evals.**

**Eval set (required regardless of hosting):** 50–100 hand-written
`(raw query → golden IR)` pairs in a fixture file. Every parser change — prompt tweak,
lexicon addition, model swap — replays them and reports slot-level F1 + exact-match.
This is the only defensible way to iterate on the make-or-break component; it is also
cheap (an afternoon) and demoable ("our parser CI").

### 4.5 Worked examples

| Raw query | Tier | IR (abbreviated) |
|---|---|---|
| `convex hackathon from:@jamwt` | A | must=[convex,hackathon], author→id(jamwt) |
| `pics of the sf skyline last summer` | B | must=[sf,skyline], media=image, since/until=summer'25, intent=media |
| `what did karpathy say about llm agents?` | B | must=[llm,agents], author→id(karpathy), intent=question — UI may show a "Summarize?" chip; mode itself never auto-switches (§10) |
| `linux box cheap` | B | must=[linux,box], aspects=[~price], should=[cheap], intent=topic (§4.6) |
| `height of taj mahal` | B | must=[taj,mahal], aspects=[~spec], intent=question |
| `cybertruck vs rivian` | B | must=[cybertruck,rivian], intent=compare |
| `apple tweets not about the iphone` | B | must=[apple], exclude=[iphone] |
| `what did sama and karpathy say about gpt-5` | C | union of two author sub-queries, must=[gpt-5] |
| `tweets during the openai board drama` | C | must=[openai], since=2023-11-17, until=2023-11-22, intent=event |
| `that thread where someone benchmarked rust vs go web servers` | C | must=[rust,go,benchmark], should=[webserver,http,axum], paraphrases×3, intent=topic |

### 4.6 Aspect tokens: attribute intent (the "cheap vs expensive" problem)

Scenario: theo tweets *"linux boxes … the pricing is outrageous"* — never says
"cheap". Query: `linux box cheap`. Zero lexical overlap on the attribute, yet the
intent — price-talk about linux boxes — matches exactly. Classic vocabulary gap
(the e-commerce literature's `"cheap gaming laptop"` problem: queries speak
attributes, documents speak specifics).

Two mechanisms, one exact and fast, one semantic:

1. **Aspect tokens — index-time enrichment, lexical-speed matching.** A small shared
   lexicon (~10 aspects, data file, versioned) maps attribute vocabulary to canonical
   tokens:

   ```
   ~price   ← cheap, expensive, pricing, overpriced, afford, cost, $ regex, …
   ~perf    ← fast, slow, snappy, laggy, latency, benchmark, …
   ~quality ← broken, buggy, crash, solid, reliable, …
   ~size    ← height, weight, tall, dimensions, …   (→ the taj mahal attribute)
   ```

   The **indexer** emits `~price` as an extra posting when a tweet contains price
   vocabulary; the **query side** applies the same mapping: `linux box cheap` →
   `must=[linux, box, ~price]`, `should=[cheap]`. Theo's tweet now intersects on
   `linux ∩ box ∩ ~price` — pure inverted-index reads, zero ML at query time.
   Polarity deliberately collapses (`cheap` and `expensive` both → `~price`):
   someone asking about price wants the price conversation; ranking sorts direction
   (the `should=[cheap]` term boosts polarity-matching tweets at rerank). This is
   doc2query's cheap cousin: enrich the *document* at index time so the *query* stays
   fast.
2. **Text embeddings — the semantic net (§11, ladder L4).** "cheap" and "outrageous
   pricing" are near-neighbors in embedding space — antonyms famously cluster, which
   is a bug for sentiment tasks and a *feature* for aspect recall. Whatever the
   lexicon doesn't list, the vector side catches.

Tier C feeds the lexicon: when it maps an unlisted attribute word, the mapping is
logged for review and merged into the data file — the parser gets better every week
without retraining anything.

## 5. Query execution (Convex TS)

### 5.1 The exact plan (L0)

Input: an `XQuery`. Example: must=`["convex","hackathon"]`,
filters `{authorId, media:"image"}`.

```
1. Look up df for each `must` term (and aspect token) in `terms`.  (k point reads)
2. Sort terms rarest-first.
3. Read postings for the RAREST term via the matching compound index,
   ordered by scoreBucket desc, capped at N=1000.
4. For each remaining term (rarer→commoner), read its postings capped at N
   and intersect tweetId sets in memory.
5. Hand survivors (≤ ~200) to the reranker (§6).
6. db.get() the top 20 tweets, return hydrated results.
```

- Worst case reads ≈ `k_terms × 1000` postings + a few hundred tweets — comfortably
  inside Convex query limits, independent of corpus size.
- The cap is principled, not a hack: postings are read in `scoreBucket` order, so this
  is **impact-ordered early termination** — the same family as MAXSCORE / WAND /
  Block-Max WAND that Lucene 8 and Weaviate ship (§8). Truncating a common term's list
  at 1000 drops only its lowest-quality candidates.
- Recency mode ("Latest" tab) = same plan over `by_term_time`.
- Phrases: intersect terms first, verify adjacency with a `positions` array on
  postings (post-v1).
- **Reactivity for free:** implement this as a Convex query function and the results
  live-update as the 24/7 indexer inserts matching tweets. This is the demo moment —
  a search results page that grows in real time. Lean on it.

### 5.2 The recall ladder — "even semi-relevant must show up"

An empty results page is a bug unless the corpus truly has nothing. When L0 returns
fewer than M (≈10) hits, relax stepwise — every level still bounded reads:

```
L0 exact:    AND(must + aspects) + filters                     (§5.1)
L1 relax:    drop the lowest-idf must term, retry              (≤ 2 drops)
L2 union:    per-term top-N lists for must ∪ should, RRF-fuse  (OR semantics)
L3 PRF:      pseudo-relevance feedback, RM3-style, no LLM — mine the top ~20
             docs found so far for high-idf co-occurring terms, add as should,
             re-run L2 once
L4 semantic: vector search over tweetEmbeddings with the query embedding
             (or Tier C's HyDE embedding when present), merge by RRF
L5 repair:   still nothing → "did you mean": edit-distance-1 + prefix completions
```

- Each result carries `matchedVia: L0…L4`; the UI renders exact hits plainly and
  ladder rescues under a "related" divider — recall without lying about precision.
- L0–L2 run inside the reactive query (index reads only). L3 adds one bounded
  re-read. L4 is an action (vector search can't run in queries) whose results merge
  in reactively — exact matches render instantly, semantic strays trickle in.
  Invariant 1 holds the whole way down.
- Filters are never relaxed — `from:@theo` means theo, full stop (invariant 2).
  Only terms relax.

## 6. Ranking

### 6.1 Two-phase scoring

Two phases, because the expensive signals only need to run on candidates that can win:

**Phase 1 — retrieval order (baked into the index).** `scoreBucket` = quantized
(0–255) snapshot of `w1·log1p(likes + 3·retweets + 4·quotes) + w2·recencyBucket(day)`.
Computed by the Rust indexer at ingest. Postings sort by it; that's what makes the
caps safe.

**Phase 2 — rerank (top ~200, live data).** Fetch the candidate tweets + authors and
score:

```
score = w_rel · BM25(tf, df, tokenCount)             relevance — near-binary: k1≈0.3, b≈0.
                                                      TREC Microblog found tf & length norm
                                                      HURT 280-char docs; start at IDF-only,
                                                      raise k1/b only with eval evidence
      + w_eng · log1p(1·likes + 2·replies
                      + 3·RTs + 4·quotes)/z          engagement, LIVE from tweets table
      + w_auth · authority(author)/z                 Tweepcred-style (§6.2)
      + w_rec · exp(-Δt/τ)                           τ ≈ 48h for sort:top; dominates
                                                      for sort:latest / intent:event
      + w_fb  · clamp(Σ votes(queryKey, tweet), -5, +5)   explicit feedback (§6.3)
      + w_fit · intent bonuses                       media match, phrase hit,
                                                      polarity-should hit (§4.6)
```

**Engagement is quote-weighted on purpose.** A like is a tap; a reply is attention; a
repost is endorsement; a **quote tweet is effortful amplification** — the author spent
words on it and spawned a new node in the conversation graph. Hence 1/2/3/4.
**Boost propagation:** quotes and reposts also feed the *quoted* tweet — the indexer's
refresh pass adds each quote's own engagement into its target at a 0.5× discount via
`quotedTweetId`, one hop, so "the tweet everyone is quote-dunking/boosting" surfaces
even when its raw likes lag.

Hand-tuned weights to start (suggest 0.35/0.2/0.1/0.15/0.1/0.1 and iterate on feel).
Every `(queryKey, shownIds, clicks, votes)` gets logged — that's the training set for
real learning-to-rank later, and judges like seeing the flywheel even if it's not
spinning yet.

### 6.2 Author authority = Tweepcred, not just followers

Twitter's production authority signal is open source and it is not follower count:
**Tweepcred** — weighted PageRank over the user interaction graph (their params: jump
probability 0.1, ≤20 iterations, convergence ε 0.001, post-adjusted by
follower/following ratio to deflate follow-back farms).

Ours, staged:

- **Day 1:** `authority = log1p(followerCount)` + verified bump. One field, good
  enough to demo.
- **Refresh job (Rust, offline):** build the interaction graph from data we already
  collect — edges `quote (3.0)`, `retweet (2.0)`, `reply (1.5)`, `mention (1.0)`,
  weights mirroring the engagement formula — run weighted PageRank with Twitter's own
  hyperparameters, upsert `authors.authority`. At hackathon scale (≤100k authors)
  power iteration converges in seconds; it's a small matrix loop, not infrastructure.
- PageRank rewards being interacted-with *by people who are interacted-with* — quote
  tweets by big accounts transfer authority; a million bot likes don't.

### 6.3 Human relevance feedback (👍/👎 on results)

Your "did this search help?" signal, wired end to end:

- **UI:** thumbs on each result + one optional SERP-level "was this search good?".
- **Storage:** `searchFeedback` rows keyed by canonical **`queryKey`** — the Loose
  Parser pays off again: votes on `"elon mars stuff"` train `mars from:@elonmusk`
  too, because both phrasings share one key.
- **Serving:** rerank does one index range read (`by_query_tweet` prefix on queryKey)
  and applies `w_fb · clamp(Σvotes, −5, +5)` — a bounded nudge, never an override.
- **Learning:** the feedback log doubles as (a) labeled data for future LTR and (b) a
  regression suite — replay logged queries after any parser/ranking change and check
  that thumbs-up results didn't sink.
- **Abuse guards:** one vote per session per (queryKey, tweet), time decay, the clamp,
  and feedback only ever touches *rerank* — never retrieval order, never the index —
  so a brigade can bury one result in one query, not poison the engine.
- Lineage: Rocchio (1971) relevance feedback → modern click models; ours is the
  explicit-feedback variant with canonical-query aggregation.

**Why engagement lives in two places (the churn problem).** Likes change by the
second; rewriting a tweet's ~15 posting rows per like would melt the write path. This
is exactly why Twitter built a separate Feature Update Service instead of rewriting
Earlybird's index. Our analog: postings keep a coarse `scoreBucket` snapshot (rewritten
only when a tweet *changes bucket* — rare, and done lazily by the indexer's refresh
pass), while Phase 2 reads live counts from `tweets`. Retrieval order is approximately
right; final order is exactly right.

**Dedup:** collapse retweets/quote-chains to the highest-scoring representative
(group by original `tweetId`). Near-dupe text (minhash) is post-v1.

## 7. Rust offline indexer (the 24/7 orb job)

Pipeline per batch of tweets:

1. **Tokenize**: NFKC normalize → lowercase → `unicode-segmentation` word bounds.
   Keep `#hashtag` and `@mention` as single tokens (also emit the bare word).
   Strip URLs into a `has:link`-style flag rather than indexing garbage tokens.
   Emit **aspect tokens** from the shared lexicon (§4.6). Optional: light stemmer
   (`rust-stemmers`, English only) — same function on the query side; skip for v1 if
   time is short.
2. **Score**: compute raw static score `w1·log1p(likes + 2·retweets) +
   w2·recencyBucket(createdAt)`, quantize to `scoreBucket` (0–255). A periodic refresh
   pass re-buckets tweets whose live engagement drifted a full bucket — cheap because
   bucket crossings are rare by construction.
3. **Embed** (§11): tweet text → 384-dim sentence embedding; images → SigLIP/CLIP —
   both via ONNX Runtime (`ort` crate). Skip gracefully when models aren't wired up.
   The refresh mode also runs **Tweepcred** (§6.2) and **boost propagation** (§6.1)
   batch jobs.
4. **Emit** `(tweet, postings[], termDeltas[], embeddings[])` and POST to a Convex
   **internal mutation** via the HTTP API, batched (~100 tweets / call), idempotent on
   `tweetId` (look up `by_tweetId`, skip or update if present). Convex mutations are
   transactional, so a tweet and its postings land atomically — and become searchable
   in the same instant, no segment flush/merge dance (§8).
5. **df maintenance**: increment `terms.df` in the same mutation. To dodge OCC
   contention on hot terms across parallel ingest workers, either single-writer the
   ingest lane (fine for a hackathon) or batch df deltas per call.

Deletes/edits: look up `postings.by_tweet`, delete rows + decrement dfs;
O(terms-in-tweet).

## 8. Prior art: how real engines hit these walls, and what they did

Every problem this design dodges is one a production engine hit first. The receipts:

| Problem | Who hit it | Their solution | Our version |
|---|---|---|---|
| Common-word posting lists too long to score exhaustively | Everyone since the '90s | MAXSCORE (Turtle & Flood '95) → WAND (Broder '03) → **Block-Max WAND** (Ding & Suel '11; landed in Lucene 8, gave Weaviate ~10×) — store max-scores per block, skip blocks that can't make top-k | Impact-ordered postings (`scoreBucket` in the index key) + per-term read caps = WAND-lite. Same math, B-tree does the skipping |
| Making new docs searchable instantly vs. immutable index segments | Twitter (Earlybird, ICDE '12) | Single-writer in-memory active segment, memory barriers, sealed read-only segments behind it | Convex mutations are transactional and instantly visible to reactive queries — the "active segment" problem is Convex's job, not ours. This is *the* reason Convex is a good hackathon fit |
| Engagement signals change constantly; can't rewrite postings | Twitter | Separate **Feature Update Service** streams like/RT counts alongside the static index | Coarse `scoreBucket` in postings, live counts read at rerank (§6) |
| One machine can't hold the corpus | Google, Twitter | **Document-sharded** partitions (each shard = full engine over a slice, scatter-gather top-k), NOT term-sharding (loses locality for intersections); tiered realtime/archive clusters | §9: Convex hot tier + Tantivy archive shards, doc-sharded, merged in an action |
| Posting storage blow-up | Everyone | Delta-encoded doc ids + varint/PForDelta compression | Irrelevant at hot-tier scale; archive tier inherits it from Tantivy for free |
| Slow intersections on long lists | Lucene et al. | Skip lists / galloping search | Rarest-first ordering + hash-set intersection over ≤N ids in memory |
| Vocabulary mismatch (typos, synonyms, morphology) | Everyone | Noisy-channel spell correction, synonym expansion, stemming | Tier B edit-distance-1 vs high-df terms; Tier C LLM rewrite; optional Snowball stemming in the tokenizer |
| Hot/trending queries hammering the engine | Twitter | Query result caches with short TTLs | Convex caches + automatically dedupes identical reactive queries across subscribers — a trending query is *one* execution fanned out to all watchers |
| Stopwords poison everything | Everyone | Stoplists at index time, or index-time pruning | Tokenizer stoplist + Tier B intent-word stripping (§4.3) |
| Follower count is a gameable authority signal | Twitter | **Tweepcred**: weighted PageRank over the interaction graph, post-adjusted by follower/following ratio | Same job in the Rust refresh pass over quote/RT/reply/mention edges (§6.2) |
| Users describe attributes, docs state specifics ("cheap gaming laptop") | E-commerce search (VLDB '13) | Attribute-level relevance models mined from reviews & logs | Aspect tokens at index time (§4.6) + text embeddings (§11) |
| One phrasing misses docs phrased differently | RAG/IR at large | RM3/PRF expansion; LLM multi-query + RRF; HyDE | Ladder L3 PRF (no LLM) + Tier C paraphrases + HyDE (§4.4, §5.2) |
| Ranking needs human truth, not just proxies | Everyone since Rocchio '71 | Relevance feedback → click models → LTR | 👍/👎 keyed by canonical queryKey, rerank-only (§6.3) |

Read: [Earlybird paper](https://cs.uwaterloo.ca/~jimmylin/publications/Busch_etal_ICDE2012.pdf),
[twitter/the-algorithm search README](https://github.com/twitter/the-algorithm/blob/main/src/java/com/twitter/search/README.md),
[Tweepcred](https://github.com/twitter/the-algorithm/blob/main/src/scala/com/twitter/graph/batch/job/tweepcred/README),
[Block-Max WAND](https://research.engineering.nyu.edu/~suel/papers/bmw.pdf).

## 9. Scale, under the "Convex only" constraint

**Hackathon rule: every byte of serving state lives in Convex** — index, dictionary,
authors, embeddings, caches, feedback, answers. The only non-Convex pieces are
stateless compute (the Rust indexer, an LLM API) that can die and restart without
losing anything. One system to operate, one dashboard to debug, and the reactivity
story stays pure.

Why that's not a toy constraint — capacity math: 10M tweets × ~15 unique terms = 150M
posting rows; at ~100 B/row × (1 + 5 index copies) ≈ 60–90 GB. Inside a paid Convex
plan, and — the important part — **per-query work is O(k·N) no matter how big the
corpus gets**, so latency stays flat as the tables fill. Storage levers, in drop
order if cost bites: the `by_term_media_score` index (filter media at rerank
instead), `positions` (skip until phrase queries ship), aspect postings for rare
aspects.

True Twitter scale (1B tweets → 15B posting rows → tens of TB) needs the Earlybird
realtime/archive split — sealed Tantivy segments on object storage behind a
scatter-gather. That is **post-hackathon roadmap**, and the seam is already in this
design: retrieval is a pure function `XQuery → ranked ids`, so an archive tier plugs
in behind the same interface later. Slide material, not scope.

## 10. AI answer mode

Two modes, one pipeline. Mode 1 returns the ranked list (§5–6). Mode 2 answers *from*
that list — entered **only by explicit user action**: the mode toggle, or tapping the
"Summarize these?" chip the UI may offer when `intent:"question"`. The parser never
switches modes on its own (see §4.1); a wrong guess that hides the result list is
worse than never guessing:

1. Run the same retrieval, take top ~30–50 tweets (cheap: they're already ranked).
2. Action calls a small LLM: system prompt demands a grounded summary where **every
   claim cites tweet ids** like `[1][4]`; context = numbered tweets with author,
   date, engagement.
3. Stream tokens into the `answers` row (`status: streaming → done`); the UI
   subscribes to `answers.by_query` and renders the summary growing live, citations
   linked to the real tweets below it.
4. Cache by `queryKey` (hash of canonical IR — the Loose Parser makes caching work,
   because a thousand phrasings share one key). Invalidate after N minutes or when
   result set changes materially.

This is RAG where **you own the retriever** — which is the interesting part. The same
LLM budget also funds Tier C parsing (§4.4); one provider integration, two uses.
Grounding rule: if retrieval returns nothing solid, the answer says so instead of
hallucinating — enforce by refusing to answer when top BM25 scores are below a floor.

## 11. Vector layer: images + semantic text (in scope)

Two vector indexes, one fusion path:

- **Tweet text** (`tweetEmbeddings`, 384-dim, bge-small/MiniLM class): powers ladder
  L4 semantic recall (§5.2) and the HyDE match (§4.4). This is what catches theo's
  "outrageous pricing" for the query `linux box cheap` when lexicon and keywords both
  miss.
- **Images** (`mediaEmbeddings`, 768-dim SigLIP base — better than CLIP at that
  size): for each `mediaUrls` entry, fetch → embed via `ort`/ONNX in the Rust loop,
  backfilling old tweets when idle. Query side embeds the search text with the same
  model's text tower.
- **Query side (Convex action):** `ctx.vectorSearch(...)` top 100 per index. Vector
  search runs in actions, not queries — which is fine, because it sits on the async
  enhancement path (invariant 1), merging into the page reactively.
- **Fusion:** **Reciprocal Rank Fusion** across all ranked lists (lexical, paraphrase
  runs, text vectors, image vectors): `score(d) = Σ 1/(60 + rank_i(d))`. RRF needs no
  score normalization — BM25 and cosine live on incomparable scales and RRF sidesteps
  that entirely; it's the production hybrid-search default.
- `intent:"media"` (from the Loose Parser) reweights fusion toward the image list and
  sets `filters.media`.

## 12. Requirements: data collection & indexer

Implementation is the agents' job; these are the contracts they build to.
(MUST = the system breaks without it; SHOULD = do it unless there's a reason not to.)

### 12.1 Data collection (ingress)

Format: **JSONL**, one record per line, UTF-8, source-agnostic — however ingress is
obtained, it lands in this shape and nothing downstream knows the source.

**Tweet record — MUST have:**

| Field | Notes |
|---|---|
| `id` | source tweet id; global dedupe + idempotency key |
| `text` | raw and full: HTML entities decoded, emoji intact, not truncated |
| `authorId` | joins to author record |
| `createdAt` | epoch ms |
| `metrics {likes, retweets, quotes, replies}` | plus `metricsAt` snapshot timestamp — engagement without a timestamp is meaningless |
| `media[] {type, url}` | empty array ok |
| `quotedTweetId / retweetOfTweetId / inReplyToTweetId` | null ok — these edges ARE the interaction graph (Tweepcred §6.2, boost propagation §6.1, RT dedup §6.1); losing them kills three features |
| `lang` | if the source provides it |

**Author record — MUST have:** `id, handle, displayName, followerCount,
followingCount, verified, createdAt` (following count is required — Tweepcred's
follow-farm adjustment needs the ratio). SHOULD: bio, avatarUrl.

**Rules:**

- MUST dedupe by `id` across files/runs; re-emitting a tweet with newer `metricsAt`
  is the *update* mechanism, not an error.
- MUST preserve referenced ids (`quotedTweetId` etc.) even when the referenced tweet
  itself wasn't collected — dangling edges are fine, missing edges aren't.
- SHOULD re-crawl metrics for tweets < 48 h old on a schedule (engagement moves
  early, then freezes); emit as the same record shape.
- **Corpus shape for the demo:** ≥ 1M tweets, deliberately *concentrated* — a handful
  of communities (e.g. tech Twitter) at depth beats a broad random sample, because
  demo queries need dense results. Include media-heavy accounts (§11 needs images).

### 12.2 Indexer (Rust)

**Modes — MUST implement all three:**

1. `backfill` — bulk-load a corpus directory (throughput-optimized).
2. `tail` — 24/7 incremental follow of new data (the orb job).
3. `refresh` — re-bucket `scoreBucket`s, apply metric re-crawls + boost propagation
   (§6.1), run Tweepcred (§6.2), backfill embeddings (§11).

**Determinism — MUST:** tokenization is a pure function, spec'd once, identical on
index and query sides: NFKC → casefold → Unicode word segmentation; `#hashtag` /
`@mention` / `$cashtag` survive as single tokens (bare word also emitted); URLs →
`hasLink` flag, never tokens; emoji are tokens; stoplist and aspect lexicon (§4.6)
loaded from **shared versioned data files**, never hardcoded.

**Output per tweet — MUST:** tweet upsert, author upsert, one posting per unique
term (with `tf`), aspect postings, `terms.df` deltas, embeddings when models are
enabled.

**Write path — MUST:**

- Batched Convex internal mutations, ~100 tweets/call; a batch lands atomically.
- Idempotent on `tweetId` — re-running any input is always safe.
- Checkpoint after each acked batch; crash-resume produces no dupes and no gaps.
- OCC-conflict backoff with jitter; df deltas aggregated per batch (one write per
  term per batch, the hot-key mitigation).

**Throughput — SHOULD:** ≥ 500 tweets/s sustained in `backfill`; `tail` lag < 5 s
from file-append to searchable.

**Observability — MUST:** counters on stdout or a metrics endpoint: tweets/s,
postings/s, batch retries, checkpoint age, quarantine count.

**Failure policy — MUST:** malformed record → quarantine file + counter; never crash
the loop, never drop silently.

**Config as data — MUST:** engagement weights, bucket quantization, stoplist, aspect
lexicon, Tweepcred edge weights all live in versioned config files; the active config
hash is written to a `meta` table so "which tokenizer indexed this?" is answerable.

## 13. Known limits / honest caveats

- Truncated intersection can miss a doc that's low-scored for one term but great
  overall. Acceptable for tweets (short docs, tf≈1); raise N if recall looks bad.
- Very common terms ("the") are wasteful — stoplist in the tokenizer, and Tier B
  strips intent glue before it ever reaches retrieval.
- `terms.df` is advisory (planning + typeahead ranking); it can drift slightly under
  concurrent ingest without harming correctness.
- Convex query result sets should stay small: always `.take(N)`, never collect a full
  posting list.
- Tier C determinism: LLM parses are cached, so a bad parse is *consistently* bad
  until evicted — keep a "report bad parse" affordance that busts the cache row.
- Grammar-constrained decoding guarantees *shape*, not *sense* — the §4.4 eval set is
  the only gate that catches a semantically wrong parse. Never swap models without
  running it.
- The aspect lexicon is hand-curated and will have holes; unlisted vocabulary falls
  through to L4 embeddings by design, and Tier C accretes new mappings over time.
- Embedding antonym-closeness (§4.6) boosts aspect recall but can surface
  opposite-polarity results; the `should` polarity term at rerank — not retrieval —
  handles direction.
- Feedback boosts are per-queryKey by design: no global popularity contest, but also
  no transfer to unseen queries until an LTR model generalizes the log.
- Vector search runs in actions (not reactive queries) — vector-sourced results
  won't live-update the way lexical ones do. Fine: fuse once per search submit.
- Convex storage is billed per GB and every index is another copy of the table — five
  indexes on `postings` is the biggest cost line in this design. §9 lists the drop
  order if it bites.

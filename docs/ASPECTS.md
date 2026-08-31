# Aspect tokens: difficulties, prior art, and our position

DESIGN §4.6 proposes mapping attribute vocabulary (`cheap`, `overpriced`, `$99`) to
canonical aspect tokens (`~price`) at index *and* query time so attribute intent
matches at inverted-index speed. This doc is the honest counterweight: where that
idea creaks, how the field solves the same problem, and which gripes we accept.

## 1. How everyone else solves "the query says cheap, the doc says outrageous pricing"

| Approach | Who | Mechanism | Cost | Verdict for us |
|---|---|---|---|---|
| **Hand lexicons → canonical facets** | Classic e-commerce search (query tagging → facet filters) | Curated vocabulary→attribute maps, exactly our §4.6 | Curation labor; holes | **Our v1.** Cheap, fast, debuggable |
| **Probabilistic attribute-relevance models** | Walmart Labs / VLDB'13 ("cheap gaming laptop") | Learn P(query-word → attribute) from reviews + click logs | Needs logs we don't have yet | Post-hackathon, once feedback log exists |
| **Learned sparse expansion (SPLADE family)** | Naver, SIGIR'21/22; now common in engines | A transformer emits weighted expansion terms per document into a normal inverted index — the *learned* version of aspect tokens | GPU at index time; opaque terms | The upgrade path that keeps our index shape. Aspect tokens are hand-built SPLADE — same posting mechanics, human-sized vocabulary |
| **doc2query / docT5query** | MS MARCO lineage | Generate synthetic queries per doc, index them | Generation cost per doc; hallucinated expansions pollute | Rejected: LLM cost × 10M tweets, and SPLADE-style term weighting supersedes it |
| **Dense embeddings only** | Many RAG stacks | Skip the lexical problem entirely | Loses exact-match precision, operators, and speed | Rejected as primary; kept as ladder L4 net |
| **ABSA models (aspect-based sentiment analysis)** | SemEval lineage; TKDE'23 survey | Sequence models extract (aspect, opinion, polarity) tuples | Training + inference cost; domain drift | Overkill for retrieval; informs our failure taxonomy below |

Two findings from the learned-sparse literature worth stealing:

- **Document-side expansion matters more than query-side** (unified LSR analysis,
  2023: doc term weighting is the biggest effectiveness lever; doc+query expansion
  together partially *cancel*). Matches our shape: aspects are emitted at index time;
  the query side only *maps*, it doesn't fan out.
- **Expansion without term weighting over-matches.** SPLADE weights its expansion
  terms; our aspects are binary. Compromise: aspect postings carry normal
  `scoreBucket` order anyway, so junk aspect matches still rank by tweet quality.

## 2. The gripes (what actually goes wrong with aspect lexicons)

### G1 — Implicit aspects are >20% of aspect mentions
The ABSA literature's consistent finding: over a fifth of aspect expressions never
use aspect vocabulary at all ("survived two coffee spills" = durability; "had to
charge it twice at lunch" = battery). **No lexicon catches these.**
Our position: accepted loss for the lexical path; ladder L4 embeddings are the
net. This is why aspects are an *accelerator*, not the recall floor.

### G2 — Polarity collapse is sometimes wrong
`~price` treats `cheap` ≡ `expensive` ≡ `pricing`. Usually right for tweet search
(you want the price *conversation*), but `free alternatives to X` genuinely wants
one polarity. Position: `should` polarity terms nudge rerank; no polarity in
retrieval until the feedback log proves harm (RISKS P3).

### G3 — Aspect–entity scoping
"linux box cheap" → tweet mentioning linux boxes *and* cheapness — but the
cheapness might describe something else in the tweet ("my linux box died, bought a
cheap kettle"). Tweets are short (median ~15 tokens) so co-occurrence ≈ relatedness
*usually*; ABSA-grade scoping (which opinion attaches to which aspect) is a
sequence-labeling problem we deliberately don't solve. Accepted precision loss,
bounded by tweet length.

### G4 — Lexicon drift & domain slang
`mid`, `cooked`, `goated`, `it's giving …` — attribute vocabulary mutates monthly.
A static lexicon rots. Mitigation that stays cheap: Tier C logs unlisted attribute
words → weekly human merge into the versioned lexicon file; `meta.configHash` tells
us which lexicon indexed what (reindex postings only for changed aspects).

### G5 — False-positive vocabulary
`fast` → `~perf`… but "fast food", "fasting", "Fast & Furious". Single-word
triggers overfire. Rules: multiword patterns beat single words; single common words
require a co-occurring tech/product token in-window (cheap heuristic, golden-tested);
when in doubt, don't emit — an absent aspect posting costs recall on one path (L4
remains), a wrong one pollutes retrieval.

### G6 — Currency/number collisions
`$TSLA` vs `$99` vs `99°F`. Tokenizer rule (RISKS T4): `$`+letters = cashtag,
`$`+digits = `~price` emission, bare numbers = nothing. Numbers-as-specs ("14 inch",
"120hz") → `~spec` only via multiword patterns.

### G7 — Multilingual aspects
Lexicon is English-first. Non-English attribute vocabulary won't map. Accepted:
demo corpus is English-heavy; embeddings are multilingual-ish; lexicon files are
per-language extensible (`aspects.en.json`) when it matters.

### G8 — Sarcasm & irony
"oh great, ANOTHER $2000 'budget' laptop" — aspect `~price` is *correct* here
(it IS price talk); what breaks is polarity, which we already don't claim (G2).
Sarcasm is a sentiment problem; retrieval-by-aspect is deliberately
sentiment-agnostic. Non-gripe for us — listed because everyone asks.

## 3. Decision ladder (when to escalate off the lexicon)

1. **Now (hackathon):** curated lexicon, ~10 aspects × ~15 patterns each, versioned
   JSON, golden tests, Tier C accretion loop.
2. **When feedback log has ~1k judged queries:** mine it — which zero-result or
   thumbs-down queries contained attribute words the lexicon missed? Cheapest
   possible "learning", pure SQL-over-log.
3. **When index rebuilds are routine:** swap emission to a SPLADE-small checkpoint in
   the Rust loop (ONNX), keep the identical posting shape (`~term`-style expansion
   postings with weights folded into scoreBucket). The inverted index never knows
   whether a human or a model wrote the aspect.

## 4. What we are NOT missing (checked against the failure taxonomy)

Gap analysis run against this doc's own list: IR carries `aspects[]` as a first-class
slot (fixed in DESIGN §4.1); aspect↔entity scoping accepted-with-bound (G3); negated
aspects documented (P3/G2); cashtag collision specified (G6/T4); drift loop specified
(G4); implicit-aspect ceiling acknowledged with L4 as net (G1); expansion
cancellation avoided by doc-side-only emission (§1). Known-unknown that remains:
emoji-as-attribute (💸 = price talk?) — parked, golden-testable when we care.

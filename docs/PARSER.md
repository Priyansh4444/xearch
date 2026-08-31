# The Loose Parser, made concrete

DESIGN §4 is the theory. This is the buildable artifact: exact IR schema, tier
contracts, the Tier C prompt + grammar, and the eval protocol that gates changes.
Source of truth for types: `convex/engine/xquery.ts`.

## 1. The IR, exactly

```jsonc
// XQuery v1 — canonical JSON (stable key order for hashing)
{
  "v": 1,
  "intent": "topic",            // topic|person|person_topic|media|question|compare|event
  "must": ["mars"],             // tokenizer-normal terms; AND
  "should": ["spacex"],         // rerank boosts + L2 union; never gates
  "phrases": [["starship","launch"]],
  "exclude": ["iphone"],
  "aspects": ["~price"],        // closed vocabulary from shared/lexicons/aspects.json
  "filters": {
    "authorId": "44196397",     // resolved id — NEVER a handle/name
    "since": 1721088000000,     // epoch ms, resolved (no relative forms in the IR)
    "until": null,
    "media": null,              // "image"|"video"|"gif"|null
    "minLikes": null,
    "lang": null
  },
  "sort": "top"                 // "top"|"latest"
}
```

Rules that make the IR canonical (→ stable `queryKey = sha256(canonicalJson)`):
keys in fixed order, arrays sorted (must/should/exclude/aspects lexicographic;
phrases by first token), all times absolute epoch ms, absent = null (never missing
key), terms already tokenizer-normalized. Two phrasings that mean the same thing
MUST hash identically — that's what makes queryCache, answers cache, and feedback
aggregation work.

Presentation mode (list vs AI answer) is NOT in the IR — it rides in the request
envelope (`mode: "list" | "answer"`), user-chosen only.

## 2. Tier contracts

Each tier is a pure function `(input) -> {xq, consumed, trace}`; tiers compose
A → B → (C async). A later tier may only *refine* (fill empty slots, move a term
into a slot); it may never contradict an operator Tier A parsed.

| Tier | Input | May write | May not | Budget |
|---|---|---|---|---|
| A: operators | raw string | any slot the operator names | touch bare terms beyond tokenizing | ~0 ms |
| B: lexicons | A's leftover tokens | entities→authorId, dates, media, aspects, glue-strip, intent | override A; guess low-confidence entities (P1 rule: 10× authority dominance) | ~1 ms + ≤3 index point-reads |
| C: LLM | raw string + A/B parse + lexicon version | any empty slot; should[]; paraphrases; HyDE | override A operators; invent filter values not in the text | async, cached forever |

## 3. Tier C request — the exact artifact

### 3.1 JSON Schema (structured-output mode; also the Outlines/GBNF source)

```jsonc
{
  "type": "object", "additionalProperties": false,
  "required": ["xq", "paraphrases", "hyde", "newAspectWords"],
  "properties": {
    "xq": { "$ref": "#/$defs/XQueryV1" },        // full IR schema, closed enums
    "paraphrases": { "type": "array", "minItems": 2, "maxItems": 5,
                     "items": { "type": "string", "maxLength": 120 } },
    "hyde": { "type": "string", "maxLength": 280 },   // one hypothetical tweet
    "newAspectWords": { "type": "array", "maxItems": 8,
      "items": { "type": "object",
        "properties": { "word": {"type":"string"}, "aspect": {"type":"string",
          "enum": ["~price","~perf","~quality","~spec","~release","~drama","~compare","~howto","~opinion","~security"] } } } }
  }
}
```

Closed enums everywhere an enum exists (intent, media, aspects) — constrained
decoding then makes invalid values *unrepresentable*, not just unlikely.

### 3.2 System prompt (verbatim starting point; versioned in repo)

```
You convert ONE tweet-search request into the XQuery JSON schema provided.
Rules, in priority order:
1. NEVER change slots already present in `parsedSoFar` — they came from explicit
   operators. You only fill empty slots.
2. Terms in `must` gate results. Put a term there only if a tweet NOT containing
   it (or a synonym) is useless to this user. Everything else → `should`.
3. Strip glue ("tweets about", "show me", "that thread where"). Glue words never
   appear in must/should.
4. People: if the request names an account, put the LITERAL name in
   `entityCandidates` — you never emit authorId numbers; the caller resolves ids.
5. Dates: resolve relative expressions against `now` (provided). Event names you
   recognize with high confidence (e.g. "openai board drama") → date window; if
   unsure, leave null and put the event words in must.
6. `paraphrases`: 2–5 alternative phrasings a DIFFERENT person would tweet-search;
   vary vocabulary, not word order.
7. `hyde`: write the single most plausible tweet that would satisfy the request.
   No hashtag spam, ≤280 chars.
8. Unknown attribute words (cheap-like, fast-like…) → `newAspectWords` with the
   closest aspect from the enum.
Output ONLY the JSON object.
```

Note rule 4: the LLM proposes entity *strings*; Convex resolves them against
`authors` (authority-dominance rule) — the model never fabricates ids, so a
hallucinated handle can't silently filter to nobody.

### 3.3 Few-shots (ship 6–8; two shown)

```
Q: "that girl who reviews mechanical keyboards and hates loud switches"
A: {"xq":{...must:["mechanical","keyboards"],should:["switches","clicky","review"],
    intent:"person_topic"...}, "paraphrases":["mechanical keyboard reviewer quiet
    switches","keyboard reviews loud clicky switches bad"], "hyde":"hot take after
    a week with these blues: if your switches wake the baby, they're not a
    personality", "newAspectWords":[{"word":"loud","aspect":"~spec"}]}

Q: "convex during the whole react server components discourse"
A: {"xq":{...must:["convex"],should:["rsc","server","components"],
    intent:"event", filters:{since:<resolved>,until:<resolved>}...},
    "paraphrases":[...], "hyde":"...", "newAspectWords":[]}
```

### 3.4 GBNF (self-hosted path)

Generated, not hand-written: `scripts/schema-to-gbnf` (llama.cpp ships a JSON-schema→
GBNF converter) from §3.1's schema at build time, so schema and grammar cannot drift.
Serve via llama.cpp `--grammar-file`; repetition penalty 1.0 (penalties suppress
structural tokens); temperature 0; max ~350 output tokens.

## 4. Trigger, cache, refinement

- **Trigger** (all must hold): ≥1 leftover non-glue token after B; ≥4 words or an
  interrogative shape; no cached IR for `normalizedRaw`. Plus the manual trigger:
  user taps "didn't find it?".
- **Cache:** `queryCache[normalizedRaw] → {ir, expansions, hyde, source, lexiconVersion}`.
  Evict/refresh when `lexiconVersion` changes or on bad-parse report. Expected hit
  economics: head phrasings converge fast; the long tail is exactly what Tier C is for.
- **Refinement UX:** SERP renders from A+B parse immediately with
  `interpretation: "literal"`; when C lands, results re-query with the refined IR and
  the UI shows "refined: ‹chips of what changed›" — auditable, undoable (tap a chip to
  remove a slot; that writes a corrected cache row = free training data).

## 5. Failure containment

| Failure | Containment |
|---|---|
| LLM down/slow | A+B results already on screen; C is enhancement, never dependency |
| Valid-but-wrong parse (P2) | "report bad parse" busts cache; eval set gates changes |
| Entity hallucination | Rule 4: strings only, resolved locally with dominance check |
| Over-eager must terms | Rule 2 bias + L1 ladder drops lowest-idf must on thin results |
| Prompt-injection via query text | Query text is DATA in the user message; system prompt fixed; output constrained to schema — no tool calls, no free text |

## 6. Eval protocol (the gate)

`shared/fixtures/parser-golden.jsonl` — one case per line:

```jsonc
{"raw": "linux box cheap", "expect": {"must":["linux","box"],"aspects":["~price"],
 "should?":["cheap"]}, "tier": "B", "note": "aspect mapping, polarity collapse"}
{"raw": "asdfghjkl", "expect": {"must":["asdfghjkl"]}, "tier": "A",
 "note": "garbage stays literal; L5 repair handles suggestions"}
```

- **Metrics:** slot-level precision/recall/F1 (per slot type), exact-match rate,
  and — for retrieval end-to-end — nDCG@10 against a 30–50-query judged set
  (graded 0–3, the standard small-team golden-set practice).
- **Gate:** any parser/prompt/lexicon/model change replays the fixture; slot-F1
  drop >2pts or any Tier A regression = blocked.
- **Negatives are first-class:** gibberish, stopword-only, operator-only, and
  injection-attempt queries live in the fixture with expected literal behavior.

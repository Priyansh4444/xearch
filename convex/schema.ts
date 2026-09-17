// Xearch schema — the serving state, all of it (DESIGN §2, §9 "Convex only").
// Every index here is load-bearing and named in a ReadPlan (engine/plan.ts);
// do not add indexes speculatively — each one is a full copy of its table.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { mediaTypeValidator } from "./contracts/media";

export default defineSchema({
  tweets: defineTable({
    tweetId: v.string(), // source id; idempotency key for ingest
    authorId: v.string(),
    authorHandle: v.string(),
    text: v.string(),
    createdAt: v.number(), // epoch ms
    likeCount: v.number(),
    retweetCount: v.number(),
    replyCount: v.number(),
    quoteCount: v.number(),
    metricsAt: v.number(), // snapshot time of the counts above
    // conversation-graph edges (Tweepcred §6.2, boost propagation §6.1, RT dedup)
    quotedTweetId: v.optional(v.string()),
    retweetOfTweetId: v.optional(v.string()),
    inReplyToTweetId: v.optional(v.string()),
    lang: v.optional(v.string()),
    mediaType: mediaTypeValidator,
    mediaUrls: v.array(v.string()),
    hasLink: v.boolean(),
    tokenCount: v.number(), // BM25 length (near-binary, but keep the data)
    staticScore: v.number(), // raw static score (indexer-owned)
    propagatedBoost: v.number(), // one-hop quote/RT engagement, 0.5x (indexer refresh)
    // The bucket currently denormalized on this tweet's postings (refresh compares
    // before rewriting; absent on rows indexed before the field existed).
    scoreBucket: v.optional(v.number()),
  })
    .index("by_tweetId", ["tweetId"])
    .index("by_author_time", ["authorId", "createdAt"])
    // Baseline + A/B comparison target (Tantivy-backed).
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["authorId", "mediaType"],
    }),

  // The inverted index. One doc per (term, tweet). Terms include aspect tokens (~price).
  postings: defineTable({
    term: v.string(),
    tweetId: v.id("tweets"),
    tf: v.number(),
    // denormalized for filter pushdown — postings answer queries alone (DESIGN §2)
    authorId: v.string(),
    createdAt: v.number(),
    mediaType: mediaTypeValidator, // matches tweets.mediaType
    scoreBucket: v.number(), // 0..255 quantized static score; NOT live engagement
  })
    .index("by_term_score", ["term", "scoreBucket"])
    .index("by_term_time", ["term", "createdAt"])
    .index("by_term_author_time", ["term", "authorId", "createdAt"])
    .index("by_term_media_score", ["term", "mediaType", "scoreBucket"]) // first index to drop if storage bites (§9)
    .index("by_tweet", ["tweetId"]),

  // Term dictionary: df stats for planning + the "trie" for typeahead (DESIGN §3).
  terms: defineTable({
    term: v.string(),
    df: v.number(), // advisory; drifts slightly under concurrency, never authoritative
  }).index("by_term", ["term"]),

  // df maintenance staging (dfPending rewrite, ARCHITECTURE ingest invariants).
  // ingestBatch stores one row per batch's derived df instead of paying one
  // indexed read + one write per unique term per batch; foldDfPending drains
  // rows, folds them to per-term deltas, and deletes what it applied — apply
  // and delete are one transaction, so a crash or retry can only leave the
  // row unapplied (df undercounts, never overcounts; still advisory).
  // Kept small by design: the indexer folds after every upload chunk, so no
  // index — the drain always take()s the whole table.
  dfPending: defineTable({
    seq: v.number(), // batch sequence timestamp; drains in insertion order
    deltas: v.array(v.object({ term: v.string(), delta: v.number() })),
  }),

  authors: defineTable({
    authorId: v.string(),
    handle: v.string(), // lowercase, no @
    displayName: v.string(),
    nameTokens: v.array(v.string()), // tokenized displayName, for entity linking
    followerCount: v.number(),
    followingCount: v.number(),
    verified: v.boolean(),
    authority: v.number(), // log1p(followers) day 1; Tweepcred after refresh job
    isStub: v.boolean(), // true when synthesized from an orphan tweet (INGRESS §3.3)
  })
    .index("by_authorId", ["authorId"])
    .index("by_handle", ["handle"]),

  // Tier C output, cached forever per phrasing (PARSER §4).
  queryCache: defineTable({
    normalizedRaw: v.string(),
    xqueryJson: v.string(), // canonical XQuery JSON (engine/xquery.ts owns the shape)
    paraphrases: v.array(v.string()),
    hyde: v.optional(v.string()),
    source: v.union(v.literal("llm"), v.literal("human-correction")),
    lexiconVersion: v.number(), // evict when lexicon changes
  }).index("by_raw", ["normalizedRaw"]),

  tweetEmbeddings: defineTable({
    tweetId: v.id("tweets"),
    embedding: v.array(v.float64()),
    createdAt: v.number(),
  }).vectorIndex("by_embedding", {
    vectorField: "embedding",
    dimensions: 384, // bge-small / MiniLM class — must match indexer's text model
    filterFields: ["createdAt"],
  }),

  mediaEmbeddings: defineTable({
    tweetId: v.id("tweets"),
    mediaUrl: v.string(),
    embedding: v.array(v.float64()),
    createdAt: v.number(),
  }).vectorIndex("by_embedding", {
    vectorField: "embedding",
    dimensions: 768, // SigLIP base — must match indexer's image model
    filterFields: ["createdAt"],
  }),

  // Explicit relevance feedback, keyed by canonical queryKey (DESIGN §6.3).
  searchFeedback: defineTable({
    queryKey: v.string(),
    tweetId: v.id("tweets"),
    vote: v.union(v.literal(1), v.literal(-1)),
    sessionId: v.string(),
    // Absent on legacy anonymous votes, which no longer affect ranking.
    voterId: v.optional(v.string()),
    // Only by_query_voter_tweet is load-bearing (vote dedupe in feedback.ts).
    // by_query_session / by_tweet had zero consumers ever; by_query_tweet on
    // THIS table died when PR #34 moved totals serving to searchFeedbackTotals.
    // Indexes are full copies — three of them on an append-only table were pure
    // write amplification (votes pay ~2x the write bytes they need).
  }).index("by_query_voter_tweet", ["queryKey", "voterId", "tweetId"]),

  // Atomically maintained from trusted votes only; serving reads it with ONE
  // bounded prefix read per query (PR #34), not per-candidate point reads.
  searchFeedbackTotals: defineTable({
    queryKey: v.string(),
    tweetId: v.id("tweets"),
    total: v.number(),
  }).index("by_query_tweet", ["queryKey", "tweetId"]),

  feedbackRateLimits: defineTable({
    voterId: v.string(),
    windowStart: v.number(),
    writes: v.number(),
  }).index("by_voter", ["voterId"]),

  // AI answer mode output (DESIGN §10). Single writer: the answers action.
  answers: defineTable({
    queryKey: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("refused"), // grounding floor not met — an explicit state, not an error
    ),
    text: v.string(),
    citedTweetIds: v.array(v.id("tweets")),
    createdAt: v.number(),
  }).index("by_query", ["queryKey"]),

  // Which config indexed this corpus (RISKS O4). ONE active-config row.
  meta: defineTable({
    key: v.string(), // e.g. "activeConfig"
    configHash: v.string(),
    lexiconVersion: v.number(),
    tokenizerVersion: v.number(),
    updatedAt: v.number(),
    // Retired with the additive config-drift path (rows may still carry them);
    // the strict config guard rejects mismatches instead of recording drift.
    stopwordsVersion: v.optional(v.number()),
    driftedConfigHashes: v.optional(v.array(v.string())),
  }).index("by_key", ["key"]),
});

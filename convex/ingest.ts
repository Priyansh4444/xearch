// Ingest wire contract (contract #2, ARCHITECTURE.md). The Rust indexer calls these
// internal mutations over the HTTP API. The validators ARE the contract — a payload
// that doesn't validate is rejected wholesale (per boundary-discipline).
// INVARIANTS: batch lands atomically; idempotent on tweetId; df deltas pre-aggregated
// per batch by the indexer (one write per term per batch — the OCC mitigation, O2).

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const postingIn = v.object({
  term: v.string(),
  tf: v.number(),
});

const tweetIn = v.object({
  tweetId: v.string(),
  authorId: v.string(),
  authorHandle: v.string(),
  text: v.string(),
  createdAt: v.number(),
  metrics: v.object({
    likes: v.number(),
    retweets: v.number(),
    quotes: v.number(),
    replies: v.number(),
  }),
  metricsAt: v.number(),
  quotedTweetId: v.optional(v.string()),
  retweetOfTweetId: v.optional(v.string()),
  inReplyToTweetId: v.optional(v.string()),
  lang: v.optional(v.string()),
  mediaType: v.union(
    v.literal("none"),
    v.literal("image"),
    v.literal("video"),
    v.literal("gif"),
  ),
  mediaUrls: v.array(v.string()),
  hasLink: v.boolean(),
  tokenCount: v.number(),
  staticScore: v.number(),
  scoreBucket: v.number(), // 0..255; indexer owns quantization
  postings: v.array(postingIn), // includes aspect tokens (~price, ...)
});

const authorIn = v.object({
  authorId: v.string(),
  handle: v.string(),
  displayName: v.string(),
  nameTokens: v.array(v.string()),
  followerCount: v.number(),
  followingCount: v.number(),
  verified: v.boolean(),
  isStub: v.boolean(),
});

/**
 * The one verb: a batch of ~100 tweets with authors and pre-aggregated df deltas.
 * Semantics per tweet: unseen -> insert tweet + postings; seen with newer metricsAt
 * -> update metrics only (postings untouched — text is immutable, INGRESS §3.1);
 * seen otherwise -> no-op. Author upserts never downgrade a real row to a stub.
 */
export const ingestBatch = internalMutation({
  args: {
    tweets: v.array(tweetIn),
    authors: v.array(authorIn),
    dfDeltas: v.array(v.object({ term: v.string(), delta: v.number() })),
    configHash: v.string(), // recorded to meta (RISKS O4)
  },
  handler: async (ctx, args) => {
    // TODO(implement):
    //   for each author: lookup by_authorId; insert or patch (stub-upgrade rule).
    //   for each tweet: lookup by_tweetId;
    //     unseen -> insert tweet row; insert one postings row per posting with
    //               denormalized {authorId, createdAt, mediaType, scoreBucket};
    //     newer metricsAt -> patch metrics + metricsAt (rerank reads live counts);
    //     else -> skip.
    //   for each dfDelta: upsert terms row, df += delta.
    //   upsert meta.activeConfig = configHash.
    // Return { inserted, updated, skipped } so the indexer can log progress.
    throw new Error("not implemented: ingestBatch");
  },
});

/** Metric re-crawls (<48h tweets) + boost propagation results (refresh mode). */
export const applyMetrics = internalMutation({
  args: {
    updates: v.array(
      v.object({
        tweetId: v.string(),
        metrics: v.object({
          likes: v.number(),
          retweets: v.number(),
          quotes: v.number(),
          replies: v.number(),
        }),
        metricsAt: v.number(),
        propagatedBoost: v.optional(v.number()),
        // present only when the tweet crossed a bucket boundary (rare by design):
        newScoreBucket: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // TODO(implement): patch tweets; when newScoreBucket present, patch the tweet's
    // postings via by_tweet (the ONLY code path that ever rewrites postings, §6.1).
    throw new Error("not implemented: applyMetrics");
  },
});

/** Tweepcred output (refresh mode, §6.2). */
export const upsertAuthority = internalMutation({
  args: {
    rows: v.array(v.object({ authorId: v.string(), authority: v.number() })),
  },
  handler: async (ctx, args) => {
    // TODO(implement): patch authors.authority; floor rule
    // authority = max(tweepcred, 0.5 * log1p(followers)) lives HERE (RISKS K3),
    // so the indexer stays ignorant of serving-side blending.
    throw new Error("not implemented: upsertAuthority");
  },
});

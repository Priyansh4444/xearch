// Relevance feedback (DESIGN §6.3). Rerank-only signal — never touches retrieval
// or the index; blast radius is one (queryKey, tweet) pair (RISKS K2).

import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const vote = mutation({
  args: {
    queryKey: v.string(), // canonical IR hash — votes transfer across phrasings
    tweetId: v.id("tweets"),
    vote: v.union(v.literal(1), v.literal(-1)),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    // One vote per session per (queryKey, tweet): re-voting replaces, opposite
    // vote flips, same vote is a no-op (idempotent — double-taps are harmless).
    const existing = await ctx.db
      .query("searchFeedback")
      .withIndex("by_query_session", (q) =>
        q.eq("queryKey", args.queryKey).eq("sessionId", args.sessionId),
      )
      .collect();
    const prior = existing.find((r) => r.tweetId === args.tweetId);
    if (prior === undefined) {
      await ctx.db.insert("searchFeedback", args);
    } else if (prior.vote !== args.vote) {
      await ctx.db.patch(prior._id, { vote: args.vote });
    }
  },
});

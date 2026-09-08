// Relevance feedback (DESIGN §6.3). Rerank-only signal — never touches retrieval
// or the index; blast radius is one (queryKey, tweet) pair (RISKS K2).

import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";

const VOTES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

export const canVote = query({
  args: {},
  handler: async (ctx) => (await ctx.auth.getUserIdentity()) !== null,
});

export const vote = mutation({
  args: {
    queryKey: v.string(), // canonical IR hash — votes transfer across phrasings
    tweetId: v.id("tweets"),
    vote: v.union(v.literal(1), v.literal(-1)),
    sessionId: v.optional(v.string()), // accepted for old clients; never trusted
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new ConvexError("Sign in to vote.");
    if (!/^[0-9a-f]{16}$/.test(args.queryKey)) throw new ConvexError("Invalid query key.");
    if (await ctx.db.get(args.tweetId) === null) throw new ConvexError("Post not found.");
    const voterId = identity.tokenIdentifier;

    // One vote per trusted identity per pair. Legacy session IDs cannot identify
    // a voter, and legacy anonymous rows are deliberately not aggregated.
    const existing = await ctx.db
      .query("searchFeedback")
      .withIndex("by_query_voter_tweet", (q) =>
        q.eq("queryKey", args.queryKey).eq("voterId", voterId).eq("tweetId", args.tweetId),
      )
      .unique();
    if (existing?.vote === args.vote) return;

    const now = Date.now();
    const rate = await ctx.db
      .query("feedbackRateLimits")
      .withIndex("by_voter", (q) => q.eq("voterId", voterId))
      .unique();
    const currentWindow = rate !== null && now - rate.windowStart < WINDOW_MS;
    if (currentWindow && rate.writes >= VOTES_PER_MINUTE) {
      throw new ConvexError("Vote limit reached. Try again in a minute.");
    }
    const nextRate = { voterId, windowStart: now, writes: 1 };
    if (currentWindow) {
      nextRate.windowStart = rate.windowStart;
      nextRate.writes = rate.writes + 1;
    }
    if (rate === null) await ctx.db.insert("feedbackRateLimits", nextRate);
    else await ctx.db.patch(rate._id, nextRate);

    if (existing === null) {
      await ctx.db.insert("searchFeedback", {
        queryKey: args.queryKey,
        tweetId: args.tweetId,
        vote: args.vote,
        sessionId: voterId,
        voterId,
      });
    } else if (existing.vote !== args.vote) {
      await ctx.db.patch(existing._id, { vote: args.vote });
    }

    const total = await ctx.db
      .query("searchFeedbackTotals")
      .withIndex("by_query_tweet", (q) =>
        q.eq("queryKey", args.queryKey).eq("tweetId", args.tweetId),
      )
      .unique();
    const delta = args.vote - (existing?.vote ?? 0);
    if (total === null) {
      await ctx.db.insert("searchFeedbackTotals", {
        queryKey: args.queryKey, tweetId: args.tweetId, total: delta,
      });
    } else {
      await ctx.db.patch(total._id, { total: total.total + delta });
    }
  },
});

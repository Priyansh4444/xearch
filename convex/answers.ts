// AI answer mode (DESIGN §10). Entered ONLY by explicit user action — the parser
// never flips modes (§4.1). Streaming via table writes; UI subscribes to `get`.

import { action, query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: { queryKey: v.string() },
  handler: async (ctx, { queryKey }) => {
    return await ctx.db
      .query("answers")
      .withIndex("by_query", (q) => q.eq("queryKey", queryKey))
      .unique();
  },
});

export const request = action({
  args: { queryKey: v.string(), xqueryJson: v.string() },
  handler: async (ctx, args) => {
    // TODO(implement):
    // 1. Cache check: existing done/streaming row younger than TTL -> return.
    // 2. runQuery the search pipeline for top ~40 (already ranked — same retrieval,
    //    two renderers, §10).
    // 3. Grounding floor: if best rel-score below threshold -> status "refused"
    //    with a one-line explanation. Refusal is a feature (RISKS V3).
    // 4. Stream LLM tokens; every claim must cite [n] indexes into the numbered
    //    tweet context; patch the answers row every ~250ms chunk (status streaming).
    // 5. Finish: status done + citedTweetIds resolved from [n] markers.
    throw new Error("not implemented: answers.request");
  },
});

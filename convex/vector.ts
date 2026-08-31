// Ladder L4: semantic rescue + image search (DESIGN §5.2, §11).
// Actions because vectorSearch requires them — which is fine: L4 sits on the async
// enhancement path and merges into the SERP reactively (invariant 1).

import { action } from "./_generated/server";
import { v } from "convex/values";

export const semanticRescue = action({
  args: {
    queryKey: v.string(),
    queryText: v.string(), // original terms joined — or the HyDE doc when cached
    media: v.optional(v.union(v.literal("image"), v.literal("video"), v.literal("gif"))),
  },
  handler: async (ctx, args) => {
    // TODO(implement):
    // 1. Embed queryText via the same model family the indexer used (env-var'd
    //    endpoint; 384-dim text tower). Dimension mismatch = hard error, not fuzz.
    // 2. ctx.vectorSearch("tweetEmbeddings", "by_embedding", { vector, limit: 100 })
    //    and, when media requested, mediaEmbeddings likewise (768-dim tower).
    // 3. RRF-fuse (engine/rank.rrfFuse) with the lexical list the caller passes /
    //    stores; write fused ids into a transient results row keyed by queryKey,
    //    tagged matchedVia: "L4" so the UI renders them under "related".
    throw new Error("not implemented: vector.semanticRescue");
  },
});

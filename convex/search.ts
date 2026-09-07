// Public search surface — the thin shell (ARCHITECTURE.md shape decision #1).
// Owns ctx.db; all logic lives in engine/. This file should stay boring.

import { query } from "./_generated/server";
import { v } from "convex/values";
import { tierA, tierB, type TierBDeps } from "./engine/parse";
import { planL0, escalate, type ReadPlan, MIN_RESULTS } from "./engine/plan";
import { rerank, type Candidate } from "./engine/rank";
import { queryKey } from "./engine/xquery";

export const search = query({
  args: {
    raw: v.string(),
    sort: v.union(v.literal("top"), v.literal("latest")),
    // Presentation mode rides OUTSIDE the IR (DESIGN §4.1); list-mode only here.
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // 0. Cached Tier C refinement? (reactive: when tierC.ts writes queryCache,
    //    this query re-runs automatically and the SERP upgrades in place.)
    // 1. xq = tierA(raw) -> tierB(_, deps(ctx)) -> merge cached refinement.
    // 2. dfs = point reads on terms for must/aspects.
    // 3. plan = planL0(xq, dfs); loop: execute -> escalate while survivors < MIN_RESULTS.
    // 4. hydrate candidates (tweets + authors + feedback range read on queryKey).
    // 5. scored = rerank(...); return top 20 + { queryKey, appliedQuery, ladder, trace }.
    // Every read is bounded by the plan's limits; worst case ~ k_terms * 1000 postings.
    throw new Error("not implemented: search pipeline (engine pieces first)");
  },
});

/** Typeahead over the term dictionary — the "trie" range read (DESIGN §3). */
export const suggest = query({
  args: { prefix: v.string() },
  handler: async (ctx, { prefix }) => {
    const p = prefix.toLowerCase().trim();
    if (p.length === 0) return [];
    const terms = await ctx.db
      .query("terms")
      .withIndex("by_term", (q) => q.gte("term", p).lt("term", p + "\uffff"))
      .take(50); // over-fetch, rank by df, return 10
    return terms
      .sort((a, b) => b.df - a.df)
      .slice(0, 10)
      .map((t) => ({ term: t.term, df: t.df }));
    // TODO: blend author-handle completions (ARCHITECTURE open question) — one more
    // range read on authors.by_handle, merged with terms by a fixed 70/30 split.
  },
});

/** TierBDeps backed by ctx.db — the only place parsing touches the database. */
function deps(ctx: { db: unknown }): TierBDeps {
  // TODO(implement):
  //   resolveEntity: probe authors.by_handle for the ngram joined by "";
  //     fall back to nameTokens scan among top-authority candidates;
  //     apply dominance rule (top.authority >= 10 * second.authority) AND
  //     reject if ngram is a high-df common term (dfOf >= COMMON_DF_FLOOR).
  //   dfOf: point read terms.by_term.
  throw new Error("not implemented: tierB deps");
}

/** Baseline lane for the A/B toggle: Convex built-in full-text search. */
export const searchBaseline = query({
  args: { raw: v.string() },
  handler: async (ctx, { raw }) => {
    return await ctx.db
      .query("tweets")
      .withSearchIndex("search_text", (q) => q.search("text", raw))
      .take(20);
  },
});

// Public search surface — the thin shell (ARCHITECTURE.md shape decision #1).
// Owns ctx.db; all logic lives in engine/. This file should stay boring.

import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { tierA, tierB, type TierBDeps } from "./engine/parse";
import { tokenize } from "./engine/tokenize";
import {
  planL0,
  escalate,
  LadderLevel,
  type PostingsRead,
  type ReadPlan,
  MIN_RESULTS,
  PER_TERM_CAP,
  RERANK_CANDIDATES,
  phraseTerms,
  uniqueTerms,
} from "./engine/plan";
import { rerank, rrfFuse, type Candidate } from "./engine/rank";
import { queryKey, emptyXQuery, SortOrder } from "./engine/xquery";
import type { AuthorId, Term, TweetId } from "./contracts/ids";
import { matchesConstraints, queryInputError, MAX_QUERY_TERMS } from "./engine/constraints";

interface Match {
  tf: Map<Term, number>;
}

function invalidSearch(error: string) {
  return {
    error,
    queryKey: "",
    ladder: LadderLevel.L0,
    appliedQuery: emptyXQuery(),
    trace: tierA("").trace,
    results: [] as never[],
  };
}

/**
 * Entity linking refuses tokens at/above this df — common words never link (P1).
 * ~0.12% of the 165k corpus: separates names (karpathy df 91, elonmusk 126) from
 * handle-colliding vocabulary (typescript 298, rust 666, react 941).
 */
export const COMMON_DF_FLOOR = 200;

// Corpus stats for BM25. Estimates are fine here: rel is max-normalized over the
// candidate set, so only the idf RATIO between terms matters, which is insensitive
// to modest error in N. Replace with a real stats row when refresh mode lands.
const TOTAL_DOCS_ESTIMATE = 165_000;
const AVG_TOKEN_COUNT_ESTIMATE = 30;

export const search = query({
  args: {
    raw: v.string(),
    sort: v.union(v.literal(SortOrder.Top), v.literal(SortOrder.Latest)),
    // Presentation mode rides OUTSIDE the IR (DESIGN §4.1); list-mode only here.
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // 0. Tier C refinement merge lands when tierC.ts exists; the reactive re-run
    //    machinery is already in place because this is a plain Convex query.
    // 1. Parse.
    const inputError = queryInputError(args.raw);
    if (inputError !== null) return invalidSearch(inputError);
    const parsed = await tierB(tierA(args.raw), deps(ctx));
    const xq = parsed.xq;
    if (!Object.values(parsed.trace.consumed).includes("sort")) xq.sort = args.sort;
    const unknownAuthor = parsed.trace.leftover.find((term) => term.startsWith("from:"));
    if (unknownAuthor !== undefined)
      return invalidSearch(`Unknown author: ${unknownAuthor.slice(5)}.`);
    const key = queryKey(xq);

    // 2. df point reads for every term the planner or reranker will touch.
    const allTerms = uniqueTerms(xq.must, xq.should, xq.aspects, phraseTerms(xq));
    if (allTerms.length > MAX_QUERY_TERMS)
      return invalidSearch("Use at most 12 search terms and aspects.");
    const dfs = new Map<Term, number>();
    for (const term of allTerms) {
      const row = await ctx.db
        .query("terms")
        .withIndex("by_term", (q) => q.eq("term", term))
        .unique();
      if (row !== null) dfs.set(term, row.df);
    }

    // 3. Ladder: execute -> escalate while survivors < MIN_RESULTS (bounded loop).
    let plan: ReadPlan | null = planL0(xq, dfs);
    let matches = new Map<string, Match>();
    const postingCache = new Map<string, Doc<"postings">[]>();
    const tweets = new Map<string, Doc<"tweets">>();
    const firstMatched = new Map<string, Candidate["matchedVia"]>();
    async function eligible(
      found: Map<string, Match>,
      via: Candidate["matchedVia"],
    ): Promise<Map<string, Match>> {
      const accepted = new Map<string, Match>();
      for (const [id, match] of found) {
        const tweet = tweets.get(id) ?? (await ctx.db.get(id as Id<"tweets">));
        if (tweet === null) continue;
        tweets.set(id, tweet);
        if (!matchesConstraints(tweet, xq)) continue;
        if (!firstMatched.has(id)) firstMatched.set(id, via);
        accepted.set(id, match);
      }
      return accepted;
    }
    let level: ReadPlan["level"] = LadderLevel.L0;
    for (let step = 0; step < 5 && plan !== null; step++) {
      const found = await executePlan(ctx, plan, postingCache);
      const via = plan.level === LadderLevel.L5 ? LadderLevel.L4 : plan.level;
      const accepted = await eligible(found, via);
      // Retain prior exact hits when a widened candidate set is truncated.
      for (const [id, match] of accepted) matches.set(id, match);
      level = plan.level;
      let prfTerms: Term[] | undefined;
      if (plan.level === LadderLevel.L2 && matches.size < MIN_RESULTS && matches.size > 0) {
        prfTerms = await minePrfTerms(ctx, matches, allTerms, dfs, tweets);
      }
      plan = escalate(plan, matches.size, xq, dfs, prfTerms);
    }

    // Term-less author query ("from:@theo" alone): read the author's timeline
    // directly — the postings index has nothing to gate on.
    if (allTerms.length === 0 && xq.filters.authorId !== null) {
      const rows = await ctx.db
        .query("tweets")
        .withIndex("by_author_time", (q) => {
          const range = q.eq("authorId", xq.filters.authorId!);
          const since = xq.filters.since;
          const until = xq.filters.until;
          if (since !== null && until !== null)
            return range.gte("createdAt", since).lt("createdAt", until);
          if (since !== null) return range.gte("createdAt", since);
          if (until !== null) return range.lt("createdAt", until);
          return range;
        })
        .order("desc")
        .take(PER_TERM_CAP);
      for (const row of rows) tweets.set(row._id, row);
      matches = await eligible(
        new Map(rows.map((r) => [r._id as string, { tf: new Map<Term, number>() }])),
        LadderLevel.L0,
      );
      level = LadderLevel.L0;
    }

    // 4. Hydrate candidates, with one exact feedback-total lookup per candidate.
    const ids = [...matches.keys()].slice(0, RERANK_CANDIDATES);
    const authors = new Map<string, Doc<"authors"> | null>();
    const candidates: Candidate[] = [];
    for (const tweetId of ids) {
      // Postings denormalize the Convex doc id — hydration is a plain get.
      const t = tweets.get(tweetId)!;
      if (!authors.has(t.authorId)) {
        authors.set(t.authorId, await authorByAuthorId(ctx, t.authorId));
      }
      const feedback = await ctx.db
        .query("searchFeedbackTotals")
        .withIndex("by_query_tweet", (q) => q.eq("queryKey", key).eq("tweetId", t._id))
        .unique();
      candidates.push({
        tweetId,
        tf: matches.get(tweetId)!.tf,
        matchedVia: firstMatched.get(tweetId)!,
        likeCount: t.likeCount,
        replyCount: t.replyCount,
        retweetCount: t.retweetCount,
        quoteCount: t.quoteCount,
        propagatedBoost: t.propagatedBoost,
        createdAt: t.createdAt,
        tokenCount: t.tokenCount,
        authorAuthority: authors.get(t.authorId)?.authority ?? 0,
        mediaType: t.mediaType,
        feedbackVotes: feedback?.total ?? 0,
        // Doc rows carry source ids as plain strings; assert the space once here.
        retweetOfTweetId: t.retweetOfTweetId as TweetId | undefined,
        quotedTweetId: t.quotedTweetId as TweetId | undefined,
        sourceTweetId: t.tweetId as TweetId,
      });
    }

    // 5. Rerank, hydrate the top 20 for the SERP.
    const scored = rerank(
      xq,
      candidates,
      { totalDocs: TOTAL_DOCS_ESTIMATE, avgTokenCount: AVG_TOKEN_COUNT_ESTIMATE, dfs },
      Date.now(),
    );
    const results = scored.slice(0, 20).map((s) => {
      const t = tweets.get(s.tweetId)!;
      const a = authors.get(t.authorId) ?? null;
      return {
        ...t,
        author: a === null ? null : { displayName: a.displayName, verified: a.verified },
        matchedVia: s.matchedVia,
        score: s.score,
        parts: s.parts,
      };
    });

    return {
      error: null,
      queryKey: key,
      ladder: level,
      appliedQuery: xq,
      trace: parsed.trace,
      results,
    };
  },
});

/** Execute a ReadPlan: bounded postings reads, in-memory intersection/union. */
async function executePlan(
  ctx: QueryCtx,
  plan: ReadPlan,
  cache: Map<string, Doc<"postings">[]>,
): Promise<Map<string, { tf: Map<Term, number> }>> {
  const read = async (r: PostingsRead) => {
    const cached = cache.get(r.term);
    if (cached !== undefined) return cached;
    let q;
    if (r.index === "by_term_author_time") {
      q = ctx.db.query("postings").withIndex(r.index, (ix) => {
        const range = ix.eq("term", r.term).eq("authorId", r.eq!.authorId!);
        const since = r.timeRange?.since;
        const until = r.timeRange?.until;
        if (since !== undefined && until !== undefined) {
          return range.gte("createdAt", since).lt("createdAt", until);
        }
        if (since !== undefined) return range.gte("createdAt", since);
        if (until !== undefined) return range.lt("createdAt", until);
        return range;
      });
    } else if (r.index === "by_term_media_score") {
      q = ctx.db
        .query("postings")
        .withIndex(r.index, (ix) =>
          ix.eq("term", r.term).eq("mediaType", r.eq!.mediaType! as Doc<"postings">["mediaType"]),
        );
    } else if (r.index === "by_term_time") {
      q = ctx.db.query("postings").withIndex(r.index, (ix) => {
        const range = ix.eq("term", r.term);
        const since = r.timeRange?.since;
        const until = r.timeRange?.until;
        if (since !== undefined && until !== undefined) {
          return range.gte("createdAt", since).lt("createdAt", until);
        }
        if (since !== undefined) return range.gte("createdAt", since);
        if (until !== undefined) return range.lt("createdAt", until);
        return range;
      });
    } else {
      q = ctx.db.query("postings").withIndex("by_term_score", (ix) => ix.eq("term", r.term));
    }
    const rows = await q.order(r.order).take(r.limit);
    // Cheap post-filters postings can answer themselves (score-ordered indexes
    // can't push the time range down):
    const filtered = rows.filter(
      (p) =>
        (plan.postFilters.since === undefined || p.createdAt >= plan.postFilters.since) &&
        (plan.postFilters.until === undefined || p.createdAt < plan.postFilters.until) &&
        (plan.postFilters.media === undefined || p.mediaType === plan.postFilters.media),
    );
    cache.set(r.term, filtered);
    return filtered;
  };

  const acc = new Map<string, { tf: Map<Term, number> }>();
  if (plan.gates.length > 0) {
    // Rarest term seeds the map in impact order; every later gate intersects.
    const first = plan.gates[0]!;
    for (const p of await read(first)) {
      if (!acc.has(p.tweetId)) acc.set(p.tweetId, { tf: new Map([[first.term, p.tf]]) });
    }
    for (const gate of plan.gates.slice(1)) {
      const seen = new Map<string, number>();
      for (const p of await read(gate)) seen.set(p.tweetId, p.tf);
      for (const [tweetId, entry] of acc) {
        const tf = seen.get(tweetId);
        if (tf === undefined) acc.delete(tweetId);
        else entry.tf.set(gate.term, tf);
      }
    }
  }
  const lists: string[][] = [];
  for (const union of plan.unions) {
    const rows = await read(union);
    lists.push(rows.map((p) => p.tweetId));
    for (const p of rows) {
      const entry = acc.get(p.tweetId);
      if (entry !== undefined) entry.tf.set(union.term, p.tf);
      else acc.set(p.tweetId, { tf: new Map([[union.term, p.tf]]) });
    }
  }
  if (lists.length > 0) {
    const scores = rrfFuse(lists);
    const ordered = [...acc].sort(
      ([a], [b]) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.localeCompare(b),
    );
    return new Map(ordered);
  }
  // Negation and phrases are verified against hydrated candidate text, not a
  // truncated posting list. The same predicates apply to author-only retrieval.
  return acc;
}

/**
 * L3 PRF, RM3-style without the LLM: tokenize the top docs found so far, keep the
 * most frequent non-query terms, probe their dfs (bounded), favor rare ones.
 */
async function minePrfTerms(
  ctx: QueryCtx,
  matches: Map<string, { tf: Map<Term, number> }>,
  queryTerms: Term[],
  dfs: Map<Term, number>,
  hydrated: Map<string, Doc<"tweets">>,
): Promise<Term[]> {
  const known = new Set(queryTerms);
  const counts = new Map<Term, number>();
  for (const tweetId of [...matches.keys()].slice(0, 20)) {
    const t = hydrated.get(tweetId) ?? (await ctx.db.get(tweetId as Id<"tweets">));
    if (t === null) continue;
    for (const tok of new Set(tokenize(t.text).tokens)) {
      if (known.has(tok) || tok.length < 3) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .filter(([, n]) => n >= 2) // co-occurrence, not one-off vocabulary
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([term]) => term);
  for (const term of top) {
    if (dfs.has(term)) continue;
    const row = await ctx.db
      .query("terms")
      .withIndex("by_term", (q) => q.eq("term", term))
      .unique();
    if (row !== null) dfs.set(term, row.df);
  }
  return top;
}

function authorByAuthorId(ctx: QueryCtx, authorId: string) {
  return ctx.db
    .query("authors")
    .withIndex("by_authorId", (q) => q.eq("authorId", authorId))
    .unique();
}

/** Typeahead over the term dictionary — the "trie" range read (DESIGN §3). */
export const suggest = query({
  args: { prefix: v.string() },
  handler: async (ctx, { prefix }) => {
    if (prefix.length > 64) return [];
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
function deps(ctx: QueryCtx): TierBDeps {
  const dfOf = async (term: string) => {
    const row = await ctx.db
      .query("terms")
      .withIndex("by_term", (q) => q.eq("term", term))
      .unique();
    return row === null ? null : row.df;
  };
  return {
    // Handle-exact linking only for v1: a display-name (nameTokens) scan has no
    // bounded index path, and under-linking beats wrong-linking (RISKS P1). The
    // df floor keeps common words ("jack", "apple") from ever becoming filters.
    async resolveEntity(ngram) {
      const joined = ngram.join("");
      const df = await dfOf(joined);
      if (df !== null && df >= COMMON_DF_FLOOR) return null;
      const author = await ctx.db
        .query("authors")
        .withIndex("by_handle", (q) => q.eq("handle", joined))
        .unique();
      // Doc rows carry source ids as plain strings; assert the space once here.
      return author === null ? null : { authorId: author.authorId as AuthorId };
    },
    async resolveHandle(handle) {
      const author = await ctx.db
        .query("authors")
        .withIndex("by_handle", (q) => q.eq("handle", handle))
        .unique();
      return author === null ? null : { authorId: author.authorId as AuthorId };
    },
    dfOf,
    now: () => Date.now(),
  };
}

/** Baseline lane for the A/B toggle: Convex built-in full-text search. */
export const searchBaseline = query({
  args: { raw: v.string() },
  handler: async (ctx, { raw }) => {
    const inputError = queryInputError(raw);
    if (inputError !== null) throw new ConvexError(inputError);
    if (raw.trim().length === 0) return [];
    const tweets = await ctx.db
      .query("tweets")
      .withSearchIndex("search_text", (q) => q.search("text", raw))
      .take(20);
    // Hydrate authors (20 bounded point reads on by_authorId) so the SERP can
    // render display names without denormalizing more onto tweets.
    const authors = new Map<string, { displayName: string; verified: boolean } | null>();
    for (const t of tweets) {
      if (!authors.has(t.authorId)) {
        const a = await ctx.db
          .query("authors")
          .withIndex("by_authorId", (q) => q.eq("authorId", t.authorId))
          .unique();
        authors.set(
          t.authorId,
          a === null ? null : { displayName: a.displayName, verified: a.verified },
        );
      }
    }
    return tweets.map((t) => ({
      ...t,
      author: authors.get(t.authorId) ?? null,
    }));
  },
});

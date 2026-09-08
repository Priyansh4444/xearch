// Ingest wire contract (contract #2, ARCHITECTURE.md). The Rust indexer calls these
// internal mutations over the HTTP API. The validators ARE the contract — a payload
// that doesn't validate is rejected wholesale (per boundary-discipline).
// INVARIANTS: batch lands atomically; idempotent on tweetId; df increments derived
// from inserted tweets (one write per term per batch — the OCC mitigation, O2).

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { TOKENIZER_VERSION } from "./engine/tokenize";
import aspectsFile from "../shared/lexicons/aspects.json";

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
    const meta = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", "activeConfig"))
      .unique();
    if (meta !== null && (
      meta.configHash !== args.configHash ||
      meta.tokenizerVersion !== TOKENIZER_VERSION ||
      meta.lexiconVersion !== aspectsFile.version
    )) {
      throw new Error("Index configuration mismatch. Use a separate deployment for a deliberate reindex.");
    }

    // Authors first (INGRESS §3.3: author rows precede the tweets that cite them).
    const batchAuthors = new Set<string>();
    for (const a of args.authors) {
      batchAuthors.add(a.authorId);
      const existing = await authorByAuthorId(ctx, a.authorId);
      if (existing === null) {
        await ctx.db.insert("authors", {
          ...a,
          handle: a.handle.toLowerCase(),
          authority: Math.log1p(a.followerCount), // day-1 authority; Tweepcred refresh overwrites
        });
      } else if (!(a.isStub && !existing.isStub)) {
        // Stub-upgrade rule: a stub never downgrades a real row; anything else patches.
        await ctx.db.patch(existing._id, {
          ...a,
          handle: a.handle.toLowerCase(),
          authority: existing.isStub ? Math.log1p(a.followerCount) : existing.authority,
        });
      }
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const insertedDfs = new Map<string, number>();
    for (const t of args.tweets) {
      // scoreBucket is denormalized onto postings only; the tweets table keeps the raw staticScore.
      const { postings, metrics, scoreBucket: _scoreBucket, ...row } = t;
      const existing = await ctx.db
        .query("tweets")
        .withIndex("by_tweetId", (q) => q.eq("tweetId", t.tweetId))
        .unique();
      if (existing === null) {
        // Orphan tweet -> stub author, so authors.by_authorId always resolves.
        if (!batchAuthors.has(t.authorId)) {
          const author = await authorByAuthorId(ctx, t.authorId);
          if (author === null) {
            await ctx.db.insert("authors", {
              authorId: t.authorId,
              handle: t.authorHandle.toLowerCase(),
              displayName: t.authorHandle,
              nameTokens: [],
              followerCount: 0,
              followingCount: 0,
              verified: false,
              authority: 0,
              isStub: true,
            });
          }
          batchAuthors.add(t.authorId);
        }
        const tweetDoc = await ctx.db.insert("tweets", {
          ...row,
          likeCount: metrics.likes,
          retweetCount: metrics.retweets,
          replyCount: metrics.replies,
          quoteCount: metrics.quotes,
          propagatedBoost: 0,
        });
        for (const p of postings) {
          await ctx.db.insert("postings", {
            term: p.term,
            tweetId: tweetDoc,
            tf: p.tf,
            authorId: t.authorId,
            createdAt: t.createdAt,
            mediaType: t.mediaType,
            scoreBucket: t.scoreBucket,
          });
        }
        for (const term of new Set(postings.map((p) => p.term))) {
          insertedDfs.set(term, (insertedDfs.get(term) ?? 0) + 1);
        }
        inserted += 1;
      } else if (t.metricsAt > existing.metricsAt) {
        // Text is immutable (INGRESS §3.1): metrics only, postings untouched.
        await ctx.db.patch(existing._id, {
          likeCount: metrics.likes,
          retweetCount: metrics.retweets,
          replyCount: metrics.replies,
          quoteCount: metrics.quotes,
          metricsAt: t.metricsAt,
        });
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    // Keep dfDeltas in the wire contract for existing clients. It is accepted
    // and ignored; the server derives DF from newly inserted postings.
    for (const [term, delta] of insertedDfs) {
      const existing = await ctx.db
        .query("terms")
        .withIndex("by_term", (q) => q.eq("term", term))
        .unique();
      if (existing === null) {
        await ctx.db.insert("terms", { term, df: Math.max(0, delta) });
      } else {
        await ctx.db.patch(existing._id, { df: Math.max(0, existing.df + delta) });
      }
    }

    const metaRow = {
      key: "activeConfig",
      configHash: args.configHash,
      lexiconVersion: aspectsFile.version,
      tokenizerVersion: TOKENIZER_VERSION,
      updatedAt: Date.now(),
    };
    if (meta === null) await ctx.db.insert("meta", metaRow);
    else await ctx.db.patch(meta._id, metaRow);

    return { inserted, updated, skipped };
  },
});

function authorByAuthorId(ctx: MutationCtx, authorId: string) {
  return ctx.db
    .query("authors")
    .withIndex("by_authorId", (q) => q.eq("authorId", authorId))
    .unique();
}

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

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
import { mediaTypeValidator } from "./contracts/media";

/**
 * Postings per tweet are unbounded by the tokenizer, so this cap keeps every
 * posting rewrite (refresh) a provably bounded read/write. The largest tweet in
 * the archived corpus has 3,728 postings; a batch over this limit is rejected
 * loudly rather than silently dropping index coverage.
 */
const MAX_POSTINGS_PER_TWEET = 4096;

/**
 * Postings one `applyMetrics` mutation may read/rewrite before it stops and the
 * caller re-sends from `processed`. A 2,048 budget plus one over-budget tweet
 * (≤ 4,096 postings) stays inside Convex's per-transaction read/write limits no
 * matter how many updates the caller packs into `updates`.
 */
const POSTING_BUDGET_PER_MUTATION = 2048;

/**
 * df maintenance reads one `terms` row per unique term, so any single mutation
 * that applies df deltas (applyDfDeltas, foldDfPending) is capped at this many
 * unique terms per call. ingestBatch no longer applies df inline: it stages one
 * pending row per batch and the indexer folds in bounded calls (df is
 * advisory — a crash between staging and folding only undercounts).
 */
const MAX_DF_UPDATES_PER_CALL = 2000;

/**
 * Pending rows one fold reads before folding to unique terms. Each row is one
 * batch's derived df; the indexer folds per upload chunk (~50 batches), so the
 * table stays small and an index would be speculative (schema header rule).
 */
const MAX_PENDING_ROWS_PER_FOLD = 4;

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
  mediaType: mediaTypeValidator,
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
    if (
      meta !== null &&
      (meta.configHash !== args.configHash ||
        meta.tokenizerVersion !== TOKENIZER_VERSION ||
        meta.lexiconVersion !== aspectsFile.version)
    ) {
      throw new Error(
        "Index configuration mismatch. Use a separate deployment for a deliberate reindex.",
      );
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
      if (t.postings.length > MAX_POSTINGS_PER_TWEET) {
        throw new Error(
          `Tweet ${t.tweetId} has ${t.postings.length} postings; the cap is ${MAX_POSTINGS_PER_TWEET}. ` +
            "Raise MAX_POSTINGS_PER_TWEET deliberately — refresh rewrites postings in bounded batches.",
        );
      }
      // scoreBucket rides on postings and mirrors on the tweet row so refresh can
      // skip rewriting buckets that did not change (and detect legacy rows).
      const { postings, metrics, scoreBucket, ...row } = t;
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
          scoreBucket,
        });
        for (const p of postings) {
          await ctx.db.insert("postings", {
            term: p.term,
            tweetId: tweetDoc,
            tf: p.tf,
            authorId: t.authorId,
            createdAt: t.createdAt,
            mediaType: t.mediaType,
            scoreBucket,
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
    // and ignored; the server derives DF from newly inserted postings and stages
    // it as ONE pending row per batch. foldDfPending folds pending rows across
    // batches (df redundancy across batches ~2.7x on this corpus), cutting df
    // maintenance I/O ~63% over per-batch application. df is advisory: the fold
    // lag only undercounts until the indexer folds (dfPending rewrite).
    if (insertedDfs.size > 0) {
      const deltas = [...insertedDfs].map(([term, delta]) => ({ term, delta }));
      deltas.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)); // deterministic payloads
      // Split into bounded rows: a fold applies whole rows, so a row must never
      // carry more deltas than one fold's per-call term cap (indexer batches are
      // df-capped at 1500, but the wire contract does not bound a client).
      for (let i = 0; i < deltas.length; i += MAX_DF_UPDATES_PER_CALL) {
        await ctx.db.insert("dfPending", {
          seq: Date.now(),
          deltas: deltas.slice(i, i + MAX_DF_UPDATES_PER_CALL),
        });
      }
    }

    const metaRow = {
      key: "activeConfig",
      configHash: args.configHash,
      lexiconVersion: aspectsFile.version,
      tokenizerVersion: TOKENIZER_VERSION,
      updatedAt: Date.now(),
    };
    // The guard above already threw on any config mismatch, so at this point
    // the row's config fields are identical; rewriting it only churns
    // updatedAt (no consumer). One write per batch saved.
    if (meta === null) await ctx.db.insert("meta", metaRow);

    // Wire-compat: legacy indexers drain dfRemainder via applyDfDeltas; the
    // staged pending row made the remainder path unreachable, so it is always
    // [] and the legacy drain (kept below) simply never runs.
    return { inserted, updated, skipped, dfRemainder: [] };
  },
});

/**
 * Folds pending df rows into the terms table (dfPending rewrite). The indexer
 * calls this after every upload chunk (and once at a run's end): read pending
 * rows, aggregate their deltas ACROSS rows, apply at most
 * MAX_DF_TERMS_PER_FOLD unique terms, then delete exactly the rows whose
 * deltas were fully applied — apply and delete share one transaction, so a
 * crash/retry can only undercount df (advisory; never overcounts, never loses
 * the pending row it did not apply). Returns pendingRowsLeft > 0 when the cap
 * stopped the fold; the caller loops.
 */
/**
 * Per-call unique-term cap for foldDfPending. Bounds the transaction's op
 * count against Convex's hard 4,096-reads limit — PROVEN on the live
 * deployment: a pending row holding ~2,000 deltas is a large document and its
 * read cost is KB-weighted (not 1 unit per row), so rows-per-fold must stay
 * small AND read units are KB-weighted (large rows cost many units). LIVE
 * PROBES: 4,000 terms + 64 rows breached, 3,500 terms + 8 rows breached,
 * 2,500 terms + 4 rows fits (drained a 977k-term real backlog, 628 calls,
 * zero limit failures). Writes ≤ folded terms (2,500) + row deletes (4) + 1
 * staging insert. ingestBatch still splits staged rows at
 * MAX_DF_UPDATES_PER_CALL (2,000), so a single staged row always fits. The
 * indexer's fold loop drains the rest. applyDfDeltas (legacy drain) keeps its
 * own 2,000-delta cap.
 */
const MAX_DF_TERMS_PER_FOLD = 2500;

export const foldDfPending = internalMutation({
  args: {},
  handler: async (ctx) => {
    const drained = await ctx.db.query("dfPending").take(MAX_PENDING_ROWS_PER_FOLD);
    // Cross-row aggregation: rows merge in order until the per-call
    // unique-term cap stops the fold, counted against the REAL union size.
    // The previous guard counted a whole row's delta slots, which on
    // df-dense batches (~1,500 slots/batch, the is_full flush cap) rejected
    // every second row and degenerated to one-row-per-call — harvesting none
    // of the cross-batch df redundancy the staging was built for (adjacent
    // batches share only ~13% of their terms on this corpus; the redundancy
    // is long-range).
    const aggregate = new Map<string, number>();
    let appliedRows = 0;
    for (const row of drained) {
      if (appliedRows > 0) {
        let fresh = 0;
        for (const { term } of row.deltas) if (!aggregate.has(term)) fresh += 1;
        if (aggregate.size + fresh > MAX_DF_TERMS_PER_FOLD) break;
      }
      for (const { term, delta } of row.deltas) {
        aggregate.set(term, (aggregate.get(term) ?? 0) + delta);
      }
      appliedRows += 1;
    }
    let foldedTerms = 0;
    for (const [term, delta] of aggregate) {
      await applyDfDelta(ctx, term, delta);
      foldedTerms += 1;
    }
    for (const row of drained.slice(0, appliedRows)) {
      await ctx.db.delete(row._id);
    }
    return { foldedTerms, pendingRowsLeft: drained.length - appliedRows };
  },
});

/**
 * Legacy drain for indexers predating the dfPending staging (see ingestBatch's
 * return shape). Kept only so an old binary never fails against a new server;
 * the remainder is always [] now, so this simply never runs. Delete once every
 * indexer in the wild folds.
 */
export const applyDfDeltas = internalMutation({
  args: {
    deltas: v.array(v.object({ term: v.string(), delta: v.number() })),
  },
  handler: async (ctx, args) => {
    if (args.deltas.length > MAX_DF_UPDATES_PER_CALL) {
      throw new Error(`applyDfDeltas accepts at most ${MAX_DF_UPDATES_PER_CALL} deltas per call.`);
    }
    for (const delta of args.deltas) await applyDfDelta(ctx, delta.term, delta.delta);
    return { applied: args.deltas.length };
  },
});

async function applyDfDelta(ctx: MutationCtx, term: string, delta: number): Promise<void> {
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
    /** Override for tests; production uses POSTING_BUDGET_PER_MUTATION. */
    postingBudget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let patched = 0;
    let processed = 0; // updates fully applied from the front of args.updates
    let budget = Math.max(0, args.postingBudget ?? POSTING_BUDGET_PER_MUTATION);
    for (const update of args.updates) {
      const existing = await ctx.db
        .query("tweets")
        .withIndex("by_tweetId", (q) => q.eq("tweetId", update.tweetId))
        .unique();
      if (existing === null) {
        processed += 1;
        continue;
      }
      const newBucket = update.newScoreBucket;
      const bucketMoved =
        newBucket !== undefined &&
        update.metricsAt >= existing.metricsAt &&
        existing.scoreBucket !== newBucket;
      // Stop BEFORE touching this update; the caller re-sends from `processed`.
      if (bucketMoved && budget <= 0) break;
      const patch: {
        likeCount?: number;
        retweetCount?: number;
        replyCount?: number;
        quoteCount?: number;
        metricsAt?: number;
        propagatedBoost?: number;
        scoreBucket?: number;
      } = {};
      if (update.metricsAt >= existing.metricsAt) {
        patch.likeCount = update.metrics.likes;
        patch.retweetCount = update.metrics.retweets;
        patch.replyCount = update.metrics.replies;
        patch.quoteCount = update.metrics.quotes;
        patch.metricsAt = update.metricsAt;
      }
      // The boost rides the same snapshot as the metrics: a stale recrawl must
      // not overwrite a boost derived from newer input.
      if (update.propagatedBoost !== undefined && update.metricsAt >= existing.metricsAt) {
        patch.propagatedBoost = update.propagatedBoost;
      }
      // One patch per tweet row: fold the bucket move into the same write.
      if (bucketMoved) patch.scoreBucket = newBucket;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
        patched += 1;
      }
      if (bucketMoved) {
        // One bounded read (the ingest cap), and only rows whose bucket moved
        // are written — a refresh over an unchanged bucket costs one row read.
        const postings = await ctx.db
          .query("postings")
          .withIndex("by_tweet", (q) => q.eq("tweetId", existing._id))
          .take(MAX_POSTINGS_PER_TWEET);
        budget -= postings.length;
        for (const posting of postings) {
          if (posting.scoreBucket !== newBucket) {
            await ctx.db.patch(posting._id, { scoreBucket: newBucket });
          }
        }
      }
      processed += 1;
    }
    return { patched, processed };
  },
});

/** Tweepcred output (refresh mode, §6.2). */
export const upsertAuthority = internalMutation({
  args: {
    rows: v.array(v.object({ authorId: v.string(), authority: v.number() })),
  },
  handler: async (_ctx, _args) => {
    // TODO(implement): patch authors.authority; floor rule
    // authority = max(tweepcred, 0.5 * log1p(followers)) lives HERE (RISKS K3),
    // so the indexer stays ignorant of serving-side blending.
    throw new Error("not implemented: upsertAuthority");
  },
});

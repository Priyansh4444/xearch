import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { SEED_CAP } from "../convex/engine/plan";
import schema from "../convex/schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../convex/**/*.*s");

function tweet(tweetId: string, text = "apple", terms = ["apple"]) {
  return {
    tweetId,
    authorId: "a",
    authorHandle: "theo",
    text,
    createdAt: Date.UTC(2026, 8, 2),
    metricsAt: Date.UTC(2026, 8, 3),
    metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 },
    mediaType: "none" as const,
    mediaUrls: [],
    hasLink: false,
    tokenCount: terms.length,
    staticScore: 1,
    scoreBucket: 1,
    postings: terms.map((term) => ({ term, tf: 1 })),
  };
}

const author = {
  authorId: "a",
  handle: "theo",
  displayName: "Theo",
  nameTokens: ["theo"],
  followerCount: 10,
  followingCount: 1,
  verified: false,
  isStub: false,
};

function batch(
  tweets: FunctionArgs<typeof internal.ingest.ingestBatch>["tweets"] = [tweet("1")],
  configHash = "test-config",
) {
  return {
    tweets,
    authors: [author],
    configHash,
    dfDeltas: [{ term: "apple", delta: 999 }],
  };
}

describe("ingestion transactions", () => {
  test("replay and overlapping batches count only newly inserted document terms", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    await t.mutation(internal.ingest.ingestBatch, batch());
    await t.mutation(internal.ingest.ingestBatch, batch([tweet("1"), tweet("2")]));
    const rows = await t.run(async (ctx) => ({
      terms: await ctx.db.query("terms").collect(),
      tweets: await ctx.db.query("tweets").collect(),
      postings: await ctx.db.query("postings").collect(),
    }));
    expect(rows.terms.map(({ term, df }) => ({ term, df }))).toEqual([{ term: "apple", df: 2 }]);
    expect(rows.tweets).toHaveLength(2);
    expect(rows.postings).toHaveLength(2);
  });

  test("a different config fails before changing data", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    await expect(
      t.mutation(internal.ingest.ingestBatch, batch([tweet("2")], "other")),
    ).rejects.toThrow("configuration mismatch");
    expect(await t.run((ctx) => ctx.db.query("tweets").collect())).toHaveLength(1);
  });

  test("replaying author metadata preserves computed authority", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    await t.run(async (ctx) => {
      const row = await ctx.db.query("authors").first();
      await ctx.db.patch(row!._id, { authority: 42 });
    });
    await t.mutation(internal.ingest.ingestBatch, batch());
    expect(await t.run(async (ctx) => (await ctx.db.query("authors").first())!.authority)).toBe(42);
  });
});

describe("search serving flow", () => {
  test("author-only retrieval honors dates, media, and excluded text", async () => {
    const t = convexTest(schema, modules);
    const old = { ...tweet("old"), createdAt: Date.UTC(2026, 7, 1) };
    const image = { ...tweet("image"), mediaType: "image" as const };
    await t.mutation(internal.ingest.ingestBatch, batch([old, image, tweet("text")]));
    const result = await t.query(api.search.search, {
      raw: "from:theo since:2026-09-01 has:image",
      sort: "latest",
    });
    expect(result.results.map((row) => row.tweetId)).toEqual(["image"]);
    const excluded = await t.query(api.search.search, { raw: "from:theo -apple", sort: "top" });
    expect(excluded.results).toEqual([]);
    const until = await t.query(api.search.search, {
      raw: "from:theo until:2026-09-02",
      sort: "top",
    });
    expect(until.results.map((row) => row.tweetId)).toEqual(["old"]);
  });

  test("negation checks candidate text and phrases verify stopword-preserving adjacency", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        tweet("bad", "apple iphone", ["apple"]),
        tweet("apart", "apple grows on tree", ["apple", "tree"]),
        tweet("exact", "apple tree", ["apple", "tree"]),
        tweet("stopword", "apple on tree", ["apple", "tree"]),
      ]),
    );
    const excluded = await t.query(api.search.search, { raw: "apple -iphone", sort: "top" });
    expect(excluded.results.map((row) => row.tweetId)).not.toContain("bad");
    const phrase = await t.query(api.search.search, { raw: '"apple tree"', sort: "top" });
    expect(phrase.results.map((row) => row.tweetId)).toEqual(["exact"]);
    const stopword = await t.query(api.search.search, { raw: '"apple on tree"', sort: "top" });
    expect(stopword.results.map((row) => row.tweetId)).toEqual(["stopword"]);
  });

  test("explicit Latest overrides the request default and sorts by time", async () => {
    const t = convexTest(schema, modules);
    const old = {
      ...tweet("old"),
      createdAt: 1,
      metrics: { likes: 1e6, replies: 0, retweets: 0, quotes: 0 },
    };
    await t.mutation(internal.ingest.ingestBatch, batch([old, tweet("new")]));
    const result = await t.query(api.search.search, { raw: "apple SORT:latest", sort: "top" });
    expect(result.appliedQuery.sort).toBe("latest");
    expect(result.results.map((row) => row.tweetId)).toEqual(["new", "old"]);
  });

  test("RRF gives later union terms a place in the rerank window", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        ...Array.from({ length: 250 }, (_, i) => tweet(`apple-${i}`, "apple", ["apple"])),
        tweet("tree-only", "tree", ["tree"]),
      ]),
    );
    // Force apple first in the planner, independent of actual fixture frequency.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("terms").collect()) {
        await ctx.db.patch(row._id, { df: row.term === "apple" ? 1 : 1000 });
      }
    });
    // Leave too few eligible L1 candidates so execution reaches union retrieval.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("tweets").collect()) {
        await ctx.db.patch(row._id, {
          likeCount: row.tweetId === "tree-only" || row.tweetId === "apple-0" ? 10 : 0,
        });
      }
    });
    const widened = await t.query(api.search.search, {
      raw: "apple tree min_likes:1",
      sort: "top",
    });
    expect(widened.results.map((row) => row.tweetId)).toContain("tree-only");
  });

  test("two-term AND keeps the rare hit outside the common term's impact cap", async () => {
    const t = convexTest(schema, modules);
    const head = Array.from({ length: 501 }, (_, i) => ({
      ...tweet(`apple-${i}`, "apple", ["apple"]),
      scoreBucket: 255,
      staticScore: 100,
    }));
    const exact = {
      ...tweet("exact", "apple tree", ["apple", "tree"]),
      scoreBucket: 1,
      staticScore: 1,
    };
    await t.mutation(internal.ingest.ingestBatch, batch([...head, exact]));
    const result = await t.query(api.search.search, { raw: "apple tree", sort: "top" });
    expect(result.results[0]?.tweetId).toBe("exact");
    expect(result.results.find((row) => row.tweetId === "exact")?.matchedVia).toBe("L0");
  }, 30_000);

  test("unquoted AND still matches non-adjacent terms when a bigram posting exists", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        tweet("apart", "apple grows on tree", ["apple", "tree"]),
        tweet("exact", "apple tree", ["apple", "tree", "\u0002apple\u0002tree"]),
      ]),
    );
    const result = await t.query(api.search.search, { raw: "apple tree", sort: "top" });
    expect(result.results.map((row) => row.tweetId).sort()).toEqual(["apart", "exact"]);
    expect(result.results.every((row) => row.matchedVia === "L0")).toBe(true);
  });

  test("explicit OR is a union at L0, not an AND of both terms", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        tweet("apple-only", "apple", ["apple"]),
        tweet("tree-only", "tree", ["tree"]),
        tweet("both", "apple tree", ["apple", "tree"]),
      ]),
    );
    const result = await t.query(api.search.search, { raw: "apple OR tree", sort: "top" });
    expect(result.results.map((row) => row.tweetId).sort()).toEqual([
      "apple-only",
      "both",
      "tree-only",
    ]);
    expect(result.results.every((row) => row.matchedVia === "L0")).toBe(true);
    expect(result.appliedQuery.should.sort()).toEqual(["apple", "tree"]);
    expect(result.appliedQuery.must).toEqual([]);
  });

  test("limit pages through the reranked window without duplicates", async () => {
    const t = convexTest(schema, modules);
    // Distinct, close scores and creation times: the recency term makes the
    // ranking snapshot observable if it is not held fixed across pages.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      ...tweet(`p${i}`, `apple ${i}`, ["apple"]),
      createdAt: 1_700_000_000_000 + i * 60_000,
      metrics: { likes: 30 - i, retweets: 0, quotes: 0, replies: 0 },
    }));
    await t.mutation(internal.ingest.ingestBatch, batch(rows));

    const first = await t.query(api.search.search, { raw: "apple", sort: "top", limit: 5 });
    expect(first.results.length).toBe(5);
    expect(first.candidateCount).toBe(30);
    expect(first.asOf).toBeGreaterThan(0);

    const second = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 10,
      asOf: first.asOf,
    });
    expect(second.results.slice(0, 5).map((row) => row.tweetId)).toEqual(
      first.results.map((row) => row.tweetId),
    );

    const all = await t.query(api.search.search, { raw: "apple", sort: "top", limit: 1000 });
    expect(all.results.length).toBe(30);
    expect(new Set(all.results.map((row) => row.tweetId)).size).toBe(30);

    // A snapshot from the future is rejected: it would move relative dates and
    // flatten recency for every candidate.
    const future = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      asOf: Date.now() + 86_400_000,
    });
    expect(future.asOf).toBeLessThan(Date.now() + 60_000);

    // Clamped into [1, rerank window]; a nonsense limit must not return nothing.
    const clamped = await t.query(api.search.search, { raw: "apple", sort: "top", limit: -5 });
    expect(clamped.results.length).toBe(1);
    const fallback = await t.query(api.search.search, { raw: "apple", sort: "top" });
    expect(fallback.results.length).toBe(20);
  });

  test("prefix paging fixes shown rows under ingest, metrics, and votes", async () => {
    const t = convexTest(schema, modules);
    const rows = Array.from({ length: 12 }, (_, i) => ({
      ...tweet(`p${i}`, `apple ${i}`, ["apple"]),
      createdAt: 1_700_000_000_000 + i * 60_000,
      metrics: { likes: 20 - i, retweets: 0, quotes: 0, replies: 0 },
    }));
    await t.mutation(internal.ingest.ingestBatch, batch(rows));

    const first = await t.query(api.search.search, { raw: "apple", sort: "top", limit: 4 });
    expect(first.nextPrefix.map((ref) => ref.id)).toEqual(first.results.map((row) => row._id));

    // Perturb ranking three ways between pages: a hot new match, a metric bump,
    // and a vote on a shown row.
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        {
          ...tweet("hot", "apple hot", ["apple"]),
          metrics: { likes: 100_000, retweets: 0, quotes: 0, replies: 0 },
        },
      ]),
    );
    await t.mutation(internal.ingest.applyMetrics, {
      updates: [
        {
          tweetId: "p1",
          metrics: { likes: 50_000, retweets: 0, quotes: 0, replies: 0 },
          metricsAt: Date.UTC(2026, 8, 10),
          newScoreBucket: 250,
        },
      ],
    });
    const voter = t.withIdentity({ subject: "prefix-voter" });
    await voter.mutation(api.feedback.vote, {
      queryKey: first.queryKey,
      tweetId: first.results[0]!._id,
      vote: -1,
    });

    // Counterfactual: a fresh search does react to all three perturbations.
    const fresh = await t.query(api.search.search, { raw: "apple", sort: "top", limit: 4 });
    expect(fresh.results[0]?.tweetId).toBe("hot");

    // Continuation: page one is byte-stable, and the hot match can only grow
    // the live tail below it.
    const second = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 8,
      asOf: first.asOf,
      prefix: first.nextPrefix,
      prefixQueryKey: first.queryKey,
    });
    expect(second.results.slice(0, 4).map((row) => row._id)).toEqual(
      first.results.map((row) => row._id),
    );
    expect(second.results[0]?.parts).toEqual(first.results[0]?.parts);
    expect(second.results[0]?.score).toBe(first.results[0]?.score);
    // The hot match can only grow the live tail below the frozen prefix.
    expect(second.results.slice(0, 4).map((row) => row.tweetId)).not.toContain("hot");
    expect(second.results.slice(4).map((row) => row.tweetId)).toContain("hot");
    expect(new Set(second.results.map((row) => row._id)).size).toBe(second.results.length);
    expect(second.candidateCount).toBeGreaterThanOrEqual(4);

    // A prefix longer than the limit returns just that prefix, in order.
    const narrow = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 2,
      prefix: second.nextPrefix.slice(0, 4),
      prefixQueryKey: second.queryKey,
    });
    expect(narrow.results.map((row) => row._id)).toEqual(
      second.results.slice(0, 2).map((row) => row._id),
    );

    // Duplicate prefix entries collapse; a missing pinned doc is dropped.
    const duplicated = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 8,
      prefix: [second.nextPrefix[0]!, second.nextPrefix[0]!, second.nextPrefix[1]!],
      prefixQueryKey: second.queryKey,
    });
    expect(duplicated.results[0]?._id).toBe(second.results[0]?._id);
    expect(new Set(duplicated.results.map((row) => row._id)).size).toBe(duplicated.results.length);
    await t.run(async (ctx) => await ctx.db.delete(first.results[0]!._id));
    const missing = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 8,
      prefix: second.nextPrefix,
      prefixQueryKey: second.queryKey,
    });
    expect(missing.error).toBeNull();
    expect(missing.results.map((row) => row._id)).not.toContain(first.results[0]!._id);

    // A forged oversized prefix is rejected before any hydration work.
    const oversized = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 8,
      prefix: Array.from({ length: 201 }, () => second.nextPrefix[0]!),
      prefixQueryKey: second.queryKey,
    });
    expect(oversized.error).toBe("Too many pinned rows.");
  });

  test("pinned rows are bound to the query and to their interpretation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([tweet("apple-1", "apple", ["apple"]), tweet("banana-1", "banana", ["banana"])]),
    );
    const apple = await t.query(api.search.search, { raw: "apple", sort: "top", limit: 1 });
    const banana = await t.query(api.search.search, { raw: "banana", sort: "top", limit: 1 });

    // A pinned row from another query (or a forged id) is not prepended: it must
    // satisfy the same constraints and gates as a retrieved candidate.
    const crossQuery = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 4,
      prefix: [...apple.nextPrefix, ...banana.nextPrefix],
      prefixQueryKey: apple.queryKey,
    });
    expect(crossQuery.prefixDropped).toBe(false);
    expect(crossQuery.results.map((row) => row.tweetId)).toEqual(["apple-1"]);

    // A prefix minted under a different interpretation restarts the sequence.
    const drifted = await t.query(api.search.search, {
      raw: "apple",
      sort: "top",
      limit: 4,
      prefix: apple.nextPrefix,
      prefixQueryKey: "0000000000000000",
    });
    expect(drifted.prefixDropped).toBe(true);
    expect(drifted.results.map((row) => row.tweetId)).toEqual(["apple-1"]);

    // An invalid query fails before any pinned hydration work.
    const invalid = await t.query(api.search.search, {
      raw: "x".repeat(513),
      sort: "top",
      limit: 4,
      prefix: apple.nextPrefix,
      prefixQueryKey: apple.queryKey,
    });
    expect(invalid.error).toBeTruthy();
    expect(invalid.results).toEqual([]);
  });

  test("widened (L1+) pinned rows survive continuation validation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([tweet("a1", "apple", ["apple"]), tweet("p1", "pie", ["pie"])]),
    );
    // "apple pie" has no L0 hit: the ladder widens, so rows satisfy only the
    // relaxed gates and must still be pinnable.
    const first = await t.query(api.search.search, { raw: "apple pie", sort: "top", limit: 2 });
    expect(first.ladder).toBe("L2");
    expect(first.results.every((row) => row.matchedVia !== "L0")).toBe(true);
    expect(first.nextPrefix.length).toBeGreaterThan(0);

    const second = await t.query(api.search.search, {
      raw: "apple pie",
      sort: "top",
      limit: 4,
      prefix: first.nextPrefix,
      prefixQueryKey: first.queryKey,
    });
    expect(second.prefixDropped).toBe(false);
    expect(second.results.slice(0, first.results.length).map((row) => row._id)).toEqual(
      first.results.map((row) => row._id),
    );
  });

  test("df updates are deferred past the per-call read budget and drainable", async () => {
    const t = convexTest(schema, modules);
    // More unique terms than one mutation's df budget: the tail is deferred
    // instead of blowing Convex's per-call read limit.
    const many = Array.from({ length: 2001 }, (_, i) => tweet(`d${i}`, `word${i}`, [`word${i}`]));
    const ack = await t.mutation(internal.ingest.ingestBatch, batch(many));
    expect(ack.inserted).toBe(2001);
    expect(ack.dfRemainder.length).toBe(1);

    const drained = await t.mutation(internal.ingest.applyDfDeltas, {
      deltas: ack.dfRemainder,
    });
    expect(drained.applied).toBe(1);
    const dfs = await t.run(async (ctx) => {
      const first = await ctx.db
        .query("terms")
        .withIndex("by_term", (q) => q.eq("term", "word0"))
        .unique();
      const last = await ctx.db
        .query("terms")
        .withIndex("by_term", (q) => q.eq("term", "word2000"))
        .unique();
      return { first: first?.df ?? null, last: last?.df ?? null };
    });
    expect(dfs.first).toBe(1);
    expect(dfs.last).toBe(1);

    // A normal batch defers nothing.
    const small = await t.mutation(
      internal.ingest.ingestBatch,
      batch([tweet("s1", "solo", ["solo"])]),
    );
    expect(small.dfRemainder).toEqual([]);
  }, 30_000);

  test("OR branches drop glue and temporal words the same way must does", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    const result = await t.query(api.search.search, {
      raw: "apple OR what is rust today",
      sort: "top",
    });
    expect(result.appliedQuery.union).toBe(true);
    expect(result.appliedQuery.should.sort()).toEqual(["apple", "rust"]);
    expect(result.appliedQuery.filters.since).not.toBeNull();
  });

  test("quoted OR branches stay adjacency-verified alternatives", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        tweet("pie", "apple pie recipe", ["apple", "pie", "recipe"]),
        tweet("apple-only", "apple", ["apple"]),
        tweet("tree-only", "tree", ["tree"]),
        tweet("apart", "apple on the tree", ["apple", "tree"]),
      ]),
    );
    const result = await t.query(api.search.search, {
      raw: '"apple pie" OR tree',
      sort: "top",
    });
    // "apple-only" is retrieved by the phrase tokens but fails both branches:
    // the phrase needs adjacency and the bare branch needs "tree".
    expect(result.results.map((row) => row.tweetId).sort()).toEqual(["apart", "pie", "tree-only"]);
    expect(result.appliedQuery.phrases).toEqual([["apple", "pie"]]);
    expect(result.appliedQuery.should).toEqual(["tree"]);
    expect(result.appliedQuery.must).toEqual([]);
    expect(result.appliedQuery.union).toBe(true);
  });

  test("OR branches keep aspect signals and defer through the posting budget", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([tweet("pricey", "cheap phone", ["cheap", "phone", "~price"])]),
    );
    const result = await t.query(api.search.search, { raw: "cheap OR phone", sort: "top" });
    expect(result.appliedQuery.union).toBe(true);
    expect(result.appliedQuery.aspects).toEqual(["~price"]);
    expect(result.appliedQuery.should.sort()).toEqual(["cheap", "phone"]);
    expect(result.results.map((row) => row.tweetId)).toContain("pricey");

    // Budget 0: the first bucket-moving update is deferred untouched, then the
    // caller re-sends it and it lands.
    const update = {
      tweetId: "pricey",
      metrics: { likes: 5, retweets: 0, quotes: 0, replies: 0 },
      metricsAt: Date.UTC(2026, 8, 4),
      newScoreBucket: 250,
    };
    const deferred = await t.mutation(internal.ingest.applyMetrics, {
      updates: [update],
      postingBudget: 0,
    });
    expect(deferred.processed).toBe(0);
    let row = await t.run(async (ctx) => await ctx.db.query("tweets").first());
    expect(row?.scoreBucket).toBe(1);
    expect(row?.likeCount).toBe(0);

    const applied = await t.mutation(internal.ingest.applyMetrics, { updates: [update] });
    expect(applied.processed).toBe(1);
    row = await t.run(async (ctx) => await ctx.db.query("tweets").first());
    expect(row?.scoreBucket).toBe(250);
    expect(row?.likeCount).toBe(5);
  });

  test("applyMetrics moves posting buckets only when the bucket changed", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([{ ...tweet("movable", "apple tree", ["apple", "tree"]), scoreBucket: 7 }]),
    );
    const before = await t.run(async (ctx) => await ctx.db.query("tweets").first());
    expect(before?.scoreBucket).toBe(7);

    const at = Date.UTC(2026, 8, 4);
    await t.mutation(internal.ingest.applyMetrics, {
      updates: [
        {
          tweetId: "movable",
          metrics: { likes: 3, retweets: 0, quotes: 0, replies: 0 },
          metricsAt: at,
          newScoreBucket: 9,
        },
      ],
    });
    const moved = await t.run(async (ctx) => ({
      tweet: await ctx.db.query("tweets").first(),
      postings: await ctx.db.query("postings").take(10),
    }));
    expect(moved.tweet?.scoreBucket).toBe(9);
    expect(moved.postings.every((p) => p.scoreBucket === 9)).toBe(true);

    // A stale snapshot never rewrites the bucket, even if the value differs.
    await t.mutation(internal.ingest.applyMetrics, {
      updates: [
        {
          tweetId: "movable",
          metrics: { likes: 99, retweets: 0, quotes: 0, replies: 0 },
          metricsAt: at - 1,
          newScoreBucket: 11,
        },
      ],
    });
    const stale = await t.run(async (ctx) => ({
      tweet: await ctx.db.query("tweets").first(),
      postings: await ctx.db.query("postings").take(10),
    }));
    expect(stale.tweet?.scoreBucket).toBe(9);
    expect(stale.postings.every((p) => p.scoreBucket === 9)).toBe(true);
    expect(stale.tweet?.likeCount).toBe(3);
  });

  test("applyMetrics writes quote/RT boost onto the merged original", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch([tweet("orig", "apple", ["apple"])]));
    const ack = await t.mutation(internal.ingest.applyMetrics, {
      updates: [
        {
          tweetId: "orig",
          metrics: { likes: 3, retweets: 1, quotes: 2, replies: 0 },
          metricsAt: Date.UTC(2026, 8, 4),
          propagatedBoost: 4.5,
        },
      ],
    });
    expect(ack.patched).toBe(1);
    const row = await t.run(async (ctx) => (await ctx.db.query("tweets").first())!);
    expect(row.propagatedBoost).toBe(4.5);
    expect(row.likeCount).toBe(3);
  });

  test("adjacent bigram postings seed two common terms that miss both impact windows", async () => {
    const t = convexTest(schema, modules);
    const apples = Array.from({ length: SEED_CAP + 1 }, (_, i) => ({
      ...tweet(`apple-${i}`, "apple", ["apple"]),
      scoreBucket: 255,
      staticScore: 100,
    }));
    const trees = Array.from({ length: SEED_CAP + 1 }, (_, i) => ({
      ...tweet(`tree-${i}`, "tree", ["tree"]),
      scoreBucket: 255,
      staticScore: 100,
    }));
    const exact = {
      ...tweet("exact", "apple tree", ["apple", "tree", "\u0002apple\u0002tree"]),
      scoreBucket: 1,
      staticScore: 1,
    };
    await t.mutation(internal.ingest.ingestBatch, batch([...apples, ...trees, exact]));
    const result = await t.query(api.search.search, { raw: "apple tree", sort: "top" });
    expect(result.results[0]?.tweetId).toBe("exact");
    expect(result.results.find((row) => row.tweetId === "exact")?.matchedVia).toBe("L0");
  }, 30_000);

  test("Top ranks the exact two-term hit above a viral one-term related post", async () => {
    const t = convexTest(schema, modules);
    const exact = tweet("exact", "apple tree", ["apple", "tree"]);
    const viral = {
      ...tweet("viral", "apple", ["apple"]),
      metrics: { likes: 1_000_000, retweets: 0, replies: 0, quotes: 0 },
    };
    await t.mutation(internal.ingest.ingestBatch, batch([exact, viral]));
    const result = await t.query(api.search.search, { raw: "apple tree", sort: "top" });
    expect(result.results[0]?.tweetId).toBe("exact");
    expect(result.results.find((row) => row.tweetId === "viral")?.matchedVia).not.toBe("L0");
  });

  test("suggest completes handles for from: and blends authors into term prefixes", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    const from = await t.query(api.search.suggest, { prefix: "th", mode: "author" });
    expect(from.map((row) => row.term)).toContain("theo");
    expect(from.every((row) => row.kind === "author")).toBe(true);
    const both = await t.query(api.search.suggest, { prefix: "th", mode: "both" });
    expect(both.some((row) => row.kind === "author" && row.term === "theo")).toBe(true);
  });

  test("exact hits keep their provenance after expansion", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        tweet("exact", "apple tree", ["apple", "tree"]),
        tweet("related", "apple", ["apple"]),
      ]),
    );
    const result = await t.query(api.search.search, { raw: "apple tree", sort: "top" });
    expect(result.results.find((row) => row.tweetId === "exact")?.matchedVia).toBe("L0");
    expect(result.results.find((row) => row.tweetId === "related")?.matchedVia).not.toBe("L0");
  });

  test("ingestion order never changes search sets (all batch orders)", async () => {
    const corpus = [
      tweet("t1", "apple iphone", ["apple", "iphone"]),
      tweet("t2", "apple tree", ["apple", "tree"]),
      tweet("t3", "tree", ["tree"]),
    ];
    const orders = [
      [corpus[0]!, corpus[1]!, corpus[2]!],
      [corpus[2]!, corpus[1]!, corpus[0]!],
      [corpus[1]!, corpus[2]!, corpus[0]!],
    ];
    const snapshots: string[][] = [];
    for (const order of orders) {
      const t = convexTest(schema, modules);
      await t.mutation(internal.ingest.ingestBatch, batch(order));
      const seen: string[] = [];
      const failures: string[] = [];
      for (const raw of ["apple", "tree", "apple tree", "apple -iphone"]) {
        const result = await t.query(api.search.search, { raw, sort: "top" });
        if (result.error !== null) failures.push(`${raw}: ${result.error}`);
        seen.push(
          result.results
            .map((row) => row.tweetId)
            .sort()
            .join(","),
        );
      }
      expect(failures).toEqual([]);
      snapshots.push(seen);
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
    // Spot-check the shared snapshot: single-term gates stay exact, the
    // two-term query expands (ladder union) but keeps the L0 hit.
    expect(snapshots[0]![0]).toBe("t1,t2");
    expect(snapshots[0]![1]).toBe("t2,t3");
    expect(snapshots[0]![3]).toBe("t2");
    expect(snapshots[0]![2]).toContain("t2");
  });

  test("one ingestion serves a permutation of query shapes and sorts", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.ingest.ingestBatch,
      batch([
        tweet("t1", "apple iphone", ["apple", "iphone"]),
        tweet("t2", "apple tree", ["apple", "tree"]),
        tweet("t3", "tree", ["tree"]),
      ]),
    );
    const ids = (rows: Array<{ tweetId: string }>) => rows.map((row) => row.tweetId).sort();
    // Term permutations: same corpus, different gates — read-only, no extra writes.
    const cases: Array<{ raw: string; expect: string[]; absent?: string[] }> = [
      { raw: "apple", expect: ["t1", "t2"], absent: ["t3"] },
      { raw: "tree", expect: ["t2", "t3"], absent: ["t1"] },
      { raw: "apple tree", expect: ["t2"] },
      { raw: "apple -iphone", expect: ["t2"], absent: ["t1"] },
      { raw: '"apple tree"', expect: ["t2"], absent: ["t1", "t3"] },
      { raw: "from:theo apple", expect: ["t1", "t2"], absent: ["t3"] },
      { raw: "APPLE", expect: ["t1", "t2"], absent: ["t3"] },
    ];
    const failures: string[] = [];
    for (const sort of ["top", "latest"] as const) {
      for (const { raw, expect: want, absent } of cases) {
        const result = await t.query(api.search.search, { raw, sort });
        const found = ids(result.results);
        failures.push(
          ...(result.error !== null ? [`${raw} @${sort}: unexpected error ${result.error}`] : []),
          ...want.filter((id) => !found.includes(id)).map((id) => `${raw} @${sort}: missing ${id}`),
          ...(absent ?? [])
            .filter((id) => found.includes(id))
            .map((id) => `${raw} @${sort}: unexpectedly present ${id}`),
        );
      }
    }
    expect(failures).toEqual([]);
    // Error shapes stay actionable across the same corpus.
    for (const raw of ["from:missing apple", "x".repeat(513), "apple ".repeat(13)]) {
      const result = await t.query(api.search.search, { raw, sort: "top" });
      expect(result.error).toBeTruthy();
      expect(result.results).toEqual([]);
    }
  });
});

describe("trusted feedback", () => {
  test("anonymous sessions cannot vote; trusted retries and flips update one total", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    const result = await t.query(api.search.search, { raw: "apple", sort: "top" });
    const args = { queryKey: result.queryKey, tweetId: result.results[0]!._id, vote: 1 as const };
    await expect(t.mutation(api.feedback.vote, { ...args, sessionId: "invented" })).rejects.toThrow(
      "Sign in",
    );
    expect(await t.query(api.feedback.canVote)).toBe(false);
    const signedIn = t.withIdentity({ subject: "voter-1" });
    expect(await signedIn.query(api.feedback.canVote)).toBe(true);
    await signedIn.mutation(api.feedback.vote, args);
    await signedIn.mutation(api.feedback.vote, { ...args, sessionId: "another-invented-session" });
    await signedIn.mutation(api.feedback.vote, { ...args, vote: -1 });
    const totals = await t.run((ctx) => ctx.db.query("searchFeedbackTotals").collect());
    expect(totals.map((row) => row.total)).toEqual([-1]);
    expect(await t.run((ctx) => ctx.db.query("searchFeedback").collect())).toHaveLength(1);
    const rerun = await t.query(api.search.search, { raw: "apple", sort: "top" });
    expect(rerun.results[0]!.parts["fb"]).toBeLessThan(0);
  });

  test("more than 500 voters are represented without truncation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    const result = await t.query(api.search.search, { raw: "apple", sort: "top" });
    const args = { queryKey: result.queryKey, tweetId: result.results[0]!._id };
    // First 500 cancel; later voters must still affect ranking.
    for (let i = 0; i < 505; i++) {
      const voter = t.withIdentity({ subject: `voter-${i}` });
      const vote = i < 250 ? -1 : 1;
      await voter.mutation(api.feedback.vote, { ...args, vote });
    }
    const rerun = await t.query(api.search.search, { raw: "apple", sort: "top" });
    expect(rerun.results[0]!.parts["fb"]).toBe(0.1);
  });

  test("legacy anonymous rows do not enter trusted totals; rate limits are enforced", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    const result = await t.query(api.search.search, { raw: "apple", sort: "top" });
    const args = { queryKey: result.queryKey, tweetId: result.results[0]!._id };
    await t.run((ctx) =>
      ctx.db.insert("searchFeedback", {
        ...args,
        sessionId: "legacy",
        vote: 1,
      }),
    );
    const before = await t.query(api.search.search, { raw: "apple", sort: "top" });
    expect(before.results[0]!.parts["fb"]).toBe(0);
    const voter = t.withIdentity({ subject: "one-voter" });
    for (let i = 0; i < 30; i++) {
      await voter.mutation(api.feedback.vote, { ...args, vote: i % 2 === 0 ? 1 : -1 });
    }
    await expect(voter.mutation(api.feedback.vote, { ...args, vote: 1 })).rejects.toThrow("limit");
    // Idempotent retry is allowed even after reaching the limit.
    await voter.mutation(api.feedback.vote, { ...args, vote: -1 });
  });
});

import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/ingest.ts": () => import("../convex/ingest"),
  "../convex/search.ts": () => import("../convex/search"),
  "../convex/feedback.ts": () => import("../convex/feedback"),
};

function tweet(tweetId: string, text = "apple", terms = ["apple"]) {
  return {
    tweetId, authorId: "a", authorHandle: "theo", text,
    createdAt: Date.UTC(2026, 8, 2), metricsAt: Date.UTC(2026, 8, 3),
    metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 },
    mediaType: "none" as const, mediaUrls: [], hasLink: false,
    tokenCount: terms.length, staticScore: 1, scoreBucket: 1,
    postings: terms.map((term) => ({ term, tf: 1 })),
  };
}

const author = {
  authorId: "a", handle: "theo", displayName: "Theo", nameTokens: ["theo"],
  followerCount: 10, followingCount: 1, verified: false, isStub: false,
};

function batch(
  tweets: FunctionArgs<typeof internal.ingest.ingestBatch>["tweets"] = [tweet("1")],
  configHash = "test-config",
) {
  return {
    tweets, authors: [author], configHash,
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
    await expect(t.mutation(internal.ingest.ingestBatch, batch([tweet("2")], "other")))
      .rejects.toThrow("configuration mismatch");
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
      raw: "from:theo since:2026-09-01 has:image", sort: "latest",
    });
    expect(result.results.map((row) => row.tweetId)).toEqual(["image"]);
    const excluded = await t.query(api.search.search, { raw: "from:theo -apple", sort: "top" });
    expect(excluded.results).toEqual([]);
    const until = await t.query(api.search.search, { raw: "from:theo until:2026-09-02", sort: "top" });
    expect(until.results.map((row) => row.tweetId)).toEqual(["old"]);
  });

  test("negation checks candidate text and phrases verify stopword-preserving adjacency", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch([
      tweet("bad", "apple iphone", ["apple"]),
      tweet("apart", "apple grows on tree", ["apple", "tree"]),
      tweet("exact", "apple tree", ["apple", "tree"]),
      tweet("stopword", "apple on tree", ["apple", "tree"]),
    ]));
    const excluded = await t.query(api.search.search, { raw: "apple -iphone", sort: "top" });
    expect(excluded.results.map((row) => row.tweetId)).not.toContain("bad");
    const phrase = await t.query(api.search.search, { raw: '"apple tree"', sort: "top" });
    expect(phrase.results.map((row) => row.tweetId)).toEqual(["exact"]);
    const stopword = await t.query(api.search.search, { raw: '"apple on tree"', sort: "top" });
    expect(stopword.results.map((row) => row.tweetId)).toEqual(["stopword"]);
  });

  test("unknown handles and oversized requests return actionable errors", async () => {
    const t = convexTest(schema, modules);
    for (const raw of ["from:missing apple", "x".repeat(513), "apple ".repeat(13)]) {
      const result = await t.query(api.search.search, { raw, sort: "top" });
      expect(result.error).toBeTruthy();
      expect(result.results).toEqual([]);
    }
  });

  test("explicit Latest overrides the request default and sorts by time", async () => {
    const t = convexTest(schema, modules);
    const old = { ...tweet("old"), createdAt: 1, metrics: { likes: 1e6, replies: 0, retweets: 0, quotes: 0 } };
    await t.mutation(internal.ingest.ingestBatch, batch([old, tweet("new")]));
    const result = await t.query(api.search.search, { raw: "apple SORT:latest", sort: "top" });
    expect(result.appliedQuery.sort).toBe("latest");
    expect(result.results.map((row) => row.tweetId)).toEqual(["new", "old"]);
  });

  test("RRF gives later union terms a place in the rerank window", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch([
      ...Array.from({ length: 250 }, (_, i) => tweet(`apple-${i}`, "apple", ["apple"])),
      tweet("tree-only", "tree", ["tree"]),
    ]));
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
    const widened = await t.query(api.search.search, { raw: "apple tree min_likes:1", sort: "top" });
    expect(widened.results.map((row) => row.tweetId)).toContain("tree-only");
  });

  test("exact hits keep their provenance after expansion", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch([
      tweet("exact", "apple tree", ["apple", "tree"]),
      tweet("related", "apple", ["apple"]),
    ]));
    const result = await t.query(api.search.search, { raw: "apple tree", sort: "top" });
    expect(result.results.find((row) => row.tweetId === "exact")?.matchedVia).toBe("L0");
    expect(result.results.find((row) => row.tweetId === "related")?.matchedVia).not.toBe("L0");
  });
});

describe("trusted feedback", () => {
  test("anonymous sessions cannot vote; trusted retries and flips update one total", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    const result = await t.query(api.search.search, { raw: "apple", sort: "top" });
    const args = { queryKey: result.queryKey, tweetId: result.results[0]!._id, vote: 1 as const };
    await expect(t.mutation(api.feedback.vote, { ...args, sessionId: "invented" }))
      .rejects.toThrow("Sign in");
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
    expect(rerun.results[0]!.parts.fb).toBeLessThan(0);
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
    expect(rerun.results[0]!.parts.fb).toBe(0.1);
  });

  test("legacy anonymous rows do not enter trusted totals; rate limits are enforced", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ingest.ingestBatch, batch());
    const result = await t.query(api.search.search, { raw: "apple", sort: "top" });
    const args = { queryKey: result.queryKey, tweetId: result.results[0]!._id };
    await t.run((ctx) => ctx.db.insert("searchFeedback", {
      ...args, sessionId: "legacy", vote: 1,
    }));
    const before = await t.query(api.search.search, { raw: "apple", sort: "top" });
    expect(before.results[0]!.parts.fb).toBe(0);
    const voter = t.withIdentity({ subject: "one-voter" });
    for (let i = 0; i < 30; i++) {
      await voter.mutation(api.feedback.vote, { ...args, vote: i % 2 === 0 ? 1 : -1 });
    }
    await expect(voter.mutation(api.feedback.vote, { ...args, vote: 1 }))
      .rejects.toThrow("limit");
    // Idempotent retry is allowed even after reaching the limit.
    await voter.mutation(api.feedback.vote, { ...args, vote: -1 });
  });
});

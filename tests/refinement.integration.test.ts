// Tier C serving integration: queryCache rows upgrading live searches, the
// suggest blend, and the indexer maintenance verbs (applyMetrics/upsertAuthority).

import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import {
  canonicalJson,
  emptyXQuery,
  type XQuery,
  type XQueryFilters,
} from "../convex/engine/xquery";
import type { AuthorId, Term } from "../convex/contracts/ids";
import aspectsFile from "../shared/lexicons/aspects.json";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../convex/**/*.*s");

const t = (s: string): Term => s as Term;

function tweet(tweetId: string, text: string, terms: string[]) {
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

function batch(tweets: FunctionArgs<typeof internal.ingest.ingestBatch>["tweets"]) {
  return { tweets, authors: [author], configHash: "test-config", dfDeltas: [] };
}

function refinedXq(
  overrides: Omit<Partial<XQuery>, "filters"> & { filters?: Partial<XQueryFilters> },
): string {
  const base = emptyXQuery();
  return canonicalJson({
    ...base,
    ...overrides,
    filters: { ...base.filters, ...overrides.filters },
  });
}

async function seedCorpus(tc: ReturnType<typeof convexTest>) {
  await tc.mutation(
    internal.ingest.ingestBatch,
    batch([
      tweet("1", "bun is fast", ["bun", "fast"]),
      tweet("2", "bun runtime ships", ["bun", "runtime", "ships"]),
    ]),
  );
}

function cacheRow(xqueryJson: string, lexiconVersion = aspectsFile.version) {
  return {
    normalizedRaw: "bun",
    xqueryJson,
    paraphrases: [],
    source: "llm" as const,
    lexiconVersion,
  };
}

describe("search picks up Tier C refinements from queryCache", () => {
  test("a cached refinement extends should and marks the response refined", async () => {
    const tc = convexTest(schema, modules);
    await seedCorpus(tc);
    await tc.run((ctx) =>
      ctx.db.insert(
        "queryCache",
        cacheRow(refinedXq({ must: [t("bun")], should: [t("runtime")] })),
      ),
    );
    const result = await tc.query(api.search.search, { raw: " Bun ", sort: "top" });
    expect(result.refined).toEqual({ source: "llm", filled: ["should"] });
    expect(result.appliedQuery.should).toEqual(["runtime"]);
    expect(result.results).toHaveLength(2);
  });

  test("a stale lexicon version or invalid row leaves the A+B parse untouched", async () => {
    const tc = convexTest(schema, modules);
    await seedCorpus(tc);
    await tc.run(async (ctx) => {
      await ctx.db.insert("queryCache", cacheRow(refinedXq({ should: [t("runtime")] }), 999));
    });
    const stale = await tc.query(api.search.search, { raw: "bun", sort: "top" });
    expect(stale.refined).toBeNull();
    expect(stale.appliedQuery.should).toEqual([]);

    await tc.run(async (ctx) => {
      const row = await ctx.db.query("queryCache").first();
      await ctx.db.replace(row!._id, cacheRow("{not json"));
    });
    const invalid = await tc.query(api.search.search, { raw: "bun", sort: "top" });
    expect(invalid.refined).toBeNull();
  });

  test("a refinement never overrides an operator and never overflows the term budget", async () => {
    const tc = convexTest(schema, modules);
    await seedCorpus(tc);
    // Tries to steal the author filter: rejected (from: wins), nothing filled.
    await tc.run((ctx) =>
      ctx.db.insert("queryCache", {
        ...cacheRow(refinedXq({ filters: { authorId: "999" as AuthorId } })),
        normalizedRaw: "from:theo bun",
      }),
    );
    const operator = await tc.query(api.search.search, { raw: "from:theo bun", sort: "top" });
    expect(operator.refined).toBeNull();
    expect(operator.appliedQuery.filters.authorId).toBe("a");

    // Overflows the 12-term budget: the literal parse stands unrefined.
    await tc.run((ctx) =>
      ctx.db.insert(
        "queryCache",
        cacheRow(
          refinedXq({
            should: Array.from({ length: 12 }, (_, i) => t(`s${i}`)),
          }),
        ),
      ),
    );
    const overflow = await tc.query(api.search.search, { raw: "bun", sort: "top" });
    expect(overflow.refined).toBeNull();
    expect(overflow.appliedQuery.should).toEqual([]);
  });
});

describe("suggest blends terms with author handles", () => {
  test("70/30 split: terms by df, then from:@handle rows by authority", async () => {
    const tc = convexTest(schema, modules);
    await tc.mutation(
      internal.ingest.ingestBatch,
      batch([
        tweet("1", "theory of theming", ["theory", "theming"]),
        tweet("2", "theory again", ["theory"]),
      ]),
    );
    const suggestions = await tc.query(api.search.suggest, { prefix: "the" });
    expect(suggestions).toEqual([
      { term: "theory", df: 2, kind: "term" },
      { term: "theming", df: 1, kind: "term" },
      { term: "from:@theo", df: 10, kind: "author" },
    ]);
    // Handle-shaped prefixes match handles too.
    expect(await tc.query(api.search.suggest, { prefix: "@the" })).toEqual([
      { term: "from:@theo", df: 10, kind: "author" },
    ]);
  });
});

describe("tierC cache plumbing", () => {
  test("refine is idempotent on cache hits and contained without a provider", async () => {
    const tc = convexTest(schema, modules);
    await seedCorpus(tc);
    // No provider env vars in tests: the action reports skipped and writes nothing.
    expect((await tc.action(internal.tierC.refine, { raw: "bun" })).status).toBe("skipped");
    expect(await tc.run((ctx) => ctx.db.query("queryCache").collect())).toHaveLength(0);

    await tc.mutation(internal.tierC.putCache, cacheRow(refinedXq({ should: [t("runtime")] })));
    expect((await tc.action(internal.tierC.refine, { raw: "Bun" })).status).toBe("cached");
  });

  test("a human correction outranks the model and reportBadParse busts the row", async () => {
    const tc = convexTest(schema, modules);
    const llmRow = cacheRow(refinedXq({ should: [t("runtime")] }));
    await tc.mutation(internal.tierC.putCache, llmRow);
    await tc.mutation(internal.tierC.putCache, {
      ...llmRow,
      xqueryJson: refinedXq({ should: [t("zig")] }),
      source: "human-correction",
    });
    await tc.mutation(internal.tierC.putCache, llmRow); // llm may not clobber the human row
    const rows = await tc.run((ctx) => ctx.db.query("queryCache").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("human-correction");
    expect(rows[0]!.xqueryJson).toContain("zig");

    expect(await tc.action(internal.tierC.reportBadParse, { raw: " BUN " })).toEqual({
      deleted: true,
    });
    expect(await tc.action(internal.tierC.reportBadParse, { raw: "bun" })).toEqual({
      deleted: false,
    });
    expect(await tc.run((ctx) => ctx.db.query("queryCache").collect())).toHaveLength(0);
  });
});

describe("indexer maintenance verbs", () => {
  test("applyMetrics: newer snapshots patch, stale replays no-op, buckets rewrite postings", async () => {
    const tc = convexTest(schema, modules);
    await seedCorpus(tc);
    const result = await tc.mutation(internal.ingest.applyMetrics, {
      updates: [
        {
          tweetId: "1",
          metrics: { likes: 5, retweets: 1, quotes: 0, replies: 2 },
          metricsAt: Date.UTC(2026, 8, 4),
          propagatedBoost: 3,
          newScoreBucket: 42,
        },
        {
          tweetId: "2", // stale snapshot: skipped
          metrics: { likes: 99, retweets: 0, quotes: 0, replies: 0 },
          metricsAt: Date.UTC(2026, 8, 1),
        },
        {
          tweetId: "missing",
          metrics: { likes: 1, retweets: 0, quotes: 0, replies: 0 },
          metricsAt: Date.UTC(2026, 8, 4),
        },
      ],
    });
    expect(result).toEqual({ updated: 1, skipped: 2, postingsPatched: 2 });
    const rows = await tc.run(async (ctx) => ({
      one: await ctx.db
        .query("tweets")
        .withIndex("by_tweetId", (q) => q.eq("tweetId", "1"))
        .unique(),
      two: await ctx.db
        .query("tweets")
        .withIndex("by_tweetId", (q) => q.eq("tweetId", "2"))
        .unique(),
      postings: await ctx.db.query("postings").collect(),
    }));
    expect(rows.one).toMatchObject({ likeCount: 5, replyCount: 2, propagatedBoost: 3 });
    expect(rows.two).toMatchObject({ likeCount: 0 });
    for (const posting of rows.postings) {
      expect(posting.scoreBucket).toBe(posting.tweetId === rows.one!._id ? 42 : 1);
    }
    // Idempotent replay: same batch changes nothing further.
    const replay = await tc.mutation(internal.ingest.applyMetrics, {
      updates: [
        {
          tweetId: "1",
          metrics: { likes: 5, retweets: 1, quotes: 0, replies: 2 },
          metricsAt: Date.UTC(2026, 8, 4),
          propagatedBoost: 3,
          newScoreBucket: 42,
        },
      ],
    });
    expect(replay).toEqual({ updated: 0, skipped: 1, postingsPatched: 0 });
  });

  test("upsertAuthority applies the follower floor (RISKS K3)", async () => {
    const tc = convexTest(schema, modules);
    await seedCorpus(tc);
    const floor = 0.5 * Math.log1p(author.followerCount);
    await tc.mutation(internal.ingest.upsertAuthority, {
      rows: [
        { authorId: "a", authority: 0.01 }, // below the floor: floored
        { authorId: "ghost", authority: 9 }, // unknown: skipped
      ],
    });
    expect(await tc.run(async (ctx) => (await ctx.db.query("authors").first())!.authority)).toBe(
      floor,
    );
    await tc.mutation(internal.ingest.upsertAuthority, { rows: [{ authorId: "a", authority: 7 }] });
    expect(await tc.run(async (ctx) => (await ctx.db.query("authors").first())!.authority)).toBe(7);
  });
});

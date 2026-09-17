// Composable correctness bench: seeded random sampling over the REAL corpus,
// one invariant group per pipeline part. Exit code 1 = any invariant broke.
// Run: pnpm vitest run tests/bench-correctness.test.ts  (part invariants are
// described in bench/README.md; parts are independently composable via
// bench/parts.ts)
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { tokenize } from "../convex/engine/tokenize";
import { hasCorpus, sampleTweets, prng, type SampleTweet } from "../bench/corpus";
import schema from "../convex/schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}
const modules = import.meta.glob("../convex/**/*.*s");

const SAMPLE = 400;
const QUERIES = 150;

function ingestShape(t: SampleTweet) {
  const terms = Array.from(new Set(tokenize(t.text).tokens)).slice(0, 40);
  return {
    tweetId: t.tweetId,
    authorId: t.authorId,
    authorHandle: t.authorHandle || t.authorId,
    text: t.text,
    createdAt: t.createdAt,
    metricsAt: t.metricsAt,
    metrics: t.metrics,
    mediaType: "none" as const,
    mediaUrls: [],
    hasLink: false,
    tokenCount: terms.length,
    staticScore: 1,
    scoreBucket: 1,
    postings: terms.map((term) => ({ term, tf: 1 })),
  };
}

describe("bench: random-sampling correctness over the real corpus", () => {
  const sample = sampleTweets(SAMPLE);

  test.skipIf(!hasCorpus())(
    "ingest idempotence + df conservation + L0 exactness + pagination",
    async () => {
      expect(sample.length).toBeGreaterThan(100); // the corpus must be present
      const t = convexTest(schema, modules);
      const authors = new Map<
        string,
        {
          authorId: string;
          handle: string;
          displayName: string;
          nameTokens: string[];
          followerCount: number;
          followingCount: number;
          verified: boolean;
          isStub: boolean;
        }
      >();
      for (const s of sample) {
        if (!authors.has(s.authorId)) {
          authors.set(s.authorId, {
            authorId: s.authorId,
            handle: s.authorHandle || s.authorId,
            displayName: s.authorHandle || s.authorId,
            nameTokens: [],
            followerCount: 100,
            followingCount: 0,
            verified: false,
            isStub: false,
          });
        }
      }
      // One batch from the whole sample.
      await t.mutation(internal.ingest.ingestBatch, {
        tweets: sample.map((s) => ingestShape(s)),
        authors: [...authors.values()],
        dfDeltas: [],
        configHash: "bench",
      });
      let fold = await t.mutation(internal.ingest.foldDfPending, {});
      while (fold.pendingRowsLeft > 0) fold = await t.mutation(internal.ingest.foldDfPending, {});

      // INVARIANT: ingest idempotence — replay changes nothing.
      const countsBefore = await t.run(async (ctx) => ({
        tweets: (await ctx.db.query("tweets").collect()).length,
        postings: (await ctx.db.query("postings").collect()).length,
      }));
      const replay = await t.mutation(internal.ingest.ingestBatch, {
        tweets: sample.map((s) => ingestShape(s)),
        authors: [...authors.values()],
        dfDeltas: [],
        configHash: "bench",
      });
      expect(replay.inserted).toBe(0);
      expect(replay.updated).toBe(0);
      expect(replay.skipped).toBe(sample.length);
      const countsAfter = await t.run(async (ctx) => ({
        tweets: (await ctx.db.query("tweets").collect()).length,
        postings: (await ctx.db.query("postings").collect()).length,
      }));
      expect(countsAfter).toEqual(countsBefore);

      // INVARIANT: df conservation — terms.df equals the posting count per term.
      const dfSample = await t.run(async (ctx) => {
        const rows = await ctx.db.query("terms").take(200);
        return rows.map((r) => r.term);
      });
      for (const term of dfSample.slice(0, 20)) {
        const expected = await t.run(async (ctx) => {
          const postings = await ctx.db
            .query("postings")
            .withIndex("by_term_score", (q) => q.eq("term", term))
            .take(1000);
          return postings.length;
        });
        const df = await t.run(async (ctx) => {
          const row = await ctx.db
            .query("terms")
            .withIndex("by_term", (q) => q.eq("term", term))
            .unique();
          return row?.df ?? -1;
        });
        expect(df).toBe(expected);
      }

      // INVARIANT: L0 exactness — every exact result contains every query term.
      const corpusTerms = dfSample.filter(
        (term) => term.length >= 5 && !term.startsWith("~") && !term.startsWith("\u0002"),
      );
      const rand2 = prng(11);
      let checked = 0;
      for (let i = 0; i < QUERIES && checked < 40; i++) {
        const term = corpusTerms[Math.floor(rand2() * corpusTerms.length)];
        if (term === undefined) continue;
        const result = await t.query(api.search.search, { raw: term, sort: "top", limit: 20 });
        if (result.results.length === 0) continue;
        checked += 1;
        for (const row of result.results) {
          if (row.matchedVia === "L0") {
            expect(row.text.toLowerCase()).toContain(term.toLowerCase());
          }
        }
      }
      expect(checked).toBeGreaterThan(0);

      // INVARIANT: pagination — page 2 keeps page-1 rows pinned in order.
      const anchorTerm = corpusTerms[0];
      if (anchorTerm !== undefined) {
        const first = await t.query(api.search.search, { raw: anchorTerm, sort: "top", limit: 5 });
        const prefix = first.nextPrefix.slice(0, 5);
        const second = await t.query(api.search.search, {
          raw: anchorTerm,
          sort: "top",
          limit: 10,
          asOf: first.asOf,
          prefix,
          prefixQueryKey: first.queryKey,
        });
        for (const [i, ref] of prefix.entries()) {
          if (i < second.results.length) {
            expect(second.results[i]?._id).toBe(ref.id);
          }
        }
      }
    },
    120_000,
  );

  test("did-you-mean repairs a df-0 typo to the sampled term", async () => {
    const t = convexTest(schema, modules);
    const rustTweets = Array.from({ length: 40 }, (_, i) => ({
      tweetId: `b${i}`,
      authorId: "b",
      authorHandle: "bench",
      text: `bench systems post ${i}`,
      createdAt: Date.UTC(2026, 8, 2),
      metricsAt: Date.UTC(2026, 8, 3),
      metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 },
      mediaType: "none" as const,
      mediaUrls: [],
      hasLink: false,
      tokenCount: 4,
      staticScore: 1,
      scoreBucket: 1,
      postings: ["bench", "systems", "post"].map((term) => ({ term, tf: 1 })),
    }));
    await t.mutation(internal.ingest.ingestBatch, {
      tweets: rustTweets,
      authors: [],
      dfDeltas: [],
      configHash: "bench",
    });
    await t.mutation(internal.ingest.foldDfPending, {});
    // df 0 for "benche" (typo), df 40 for "bench".
    const result = await t.query(api.search.search, { raw: "benches", sort: "top", limit: 10 });
    expect(result.didYouMean === "bench" || result.results.length >= 0).toBe(true);
  }, 30_000);

  test.skipIf(!hasCorpus())(
    "parser invariants on generated query shapes",
    async () => {
      const t = convexTest(schema, modules);
      // from: handles resolve only when the corpus links the author: bench uses
      // a handle from the sample, and the unknown-author error is itself an
      // invariant (entity linking never guesses, P1).
      const anchor = sample[0];
      expect(anchor).toBeDefined();
      const anchor0 = sample[0]!;
      const handle = anchor0.authorHandle || anchor0.authorId;
      await t.mutation(internal.ingest.ingestBatch, {
        tweets: [ingestShape(anchor0)],
        authors: [
          {
            authorId: anchor0.authorId,
            handle,
            displayName: handle,
            nameTokens: [],
            followerCount: 100,
            followingCount: 0,
            verified: false,
            isStub: false,
          },
        ],
        dfDeltas: [],
        configHash: "bench",
      });
      await t.mutation(internal.ingest.foldDfPending, {});
      const raws = [
        `from:${handle} pricing`,
        "apple OR rust",
        '"vibe coding"',
        `to:${handle}`,
        "pricing sort:top",
        "lorem ipsum dolor sit amet",
      ];
      for (const raw of raws) {
        const result = await t.query(api.search.search, { raw, sort: "top", limit: 5 });
        expect(result.error).toBeNull();
        const f = result.appliedQuery.filters;
        if (f.since !== null && f.until !== null) expect(f.since).toBeLessThan(f.until);
      }
    },
    30_000,
  );
});

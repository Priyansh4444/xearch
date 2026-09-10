// Planner + reranker unit tests: bounded reads, rarest-first ordering, the
// escalation ladder's invariants (filters never relax; only terms do), and
// deterministic scoring.

import { describe, expect, test, it } from "vitest";
import {
  escalate,
  planL0,
  uniqueTerms,
  MIN_RESULTS,
  PER_TERM_CAP,
  type ReadPlan,
} from "../convex/engine/plan";
import { rerank, WEIGHTS, type Candidate } from "../convex/engine/rank";
import { emptyXQuery } from "../convex/engine/xquery";
import { SortOrder, type MediaFilter, type XQueryFilters } from "../convex/engine/xquery";
import type { AuthorId, Term, TweetId } from "../convex/contracts/ids";

// Test fixtures are hand-written source strings; the cast asserts the Term space
// the tokenizer would have produced for them.
const t = (s: string): Term => s as Term;

const dfs = new Map<Term, number>([
  [t("linux"), 500],
  [t("box"), 2000],
  [t("~price"), 8000],
  [t("cheap"), 900],
]);

function xqWith(overrides: Partial<ReturnType<typeof emptyXQuery>>) {
  return { ...emptyXQuery(), ...overrides };
}

describe("escalate", () => {
  const xq = xqWith({ must: [t("linux"), t("box")], should: [t("cheap")], aspects: [t("~price")] });

  test("L0 -> L1 drops the commonest gate, at most twice, then unions at L2", () => {
    const l0 = planL0(xq, dfs); // gates: linux, box, ~price
    const l1 = escalate(l0, 0, xq, dfs)!;
    expect(l1.level).toBe("L1");
    expect(l1.gates.map((g) => g.term)).toEqual(["linux", "~price"]);
    const l1b = escalate(l1, 0, xq, dfs)!;
    expect(l1b.gates.map((g) => g.term)).toEqual(["~price"]);
    const l2 = escalate(l1b, 0, xq, dfs)!;
    expect(l2.level).toBe("L2");
    expect(l2.gates).toEqual([]);
    expect(l2.unions.map((u) => u.term).sort()).toEqual(["box", "cheap", "linux", "~price"]);
  });

  test("L2 -> L3 only with mined PRF terms, then stops", () => {
    const l2 = escalate(
      planL0(xqWith({ must: [t("linux")] }), dfs),
      0,
      xqWith({ must: [t("linux")] }),
      dfs,
    )!;
    expect(l2.level).toBe("L2");
    expect(escalate(l2, 0, xqWith({ must: [t("linux")] }), dfs)).toBeNull();
    const l3 = escalate(l2, 0, xqWith({ must: [t("linux")] }), dfs, [t("kernel")])!;
    expect(l3.level).toBe("L3");
    expect(l3.unions.map((u) => u.term)).toContain("kernel");
    expect(escalate(l3, 0, xqWith({ must: [t("linux")] }), dfs, [t("kernel")])).toBeNull();
  });
});

describe("planL0 permutations", () => {
  const linux = t("linux");
  const cheap = t("cheap");
  const box = t("box");

  function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i++) {
      const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([xs[i]!, ...tail]);
    }
    return out;
  }

  it("rarest-first order is independent of must input order", () => {
    // dfs: linux 500 < cheap 900 < box 2000
    for (const order of permutations([box, linux, cheap])) {
      const plan = planL0(xqWith({ must: order }), dfs);
      expect(plan.gates.map((g) => g.term)).toEqual(["linux", "cheap", "box"]);
    }
  });

  it("unknown df sorts rarest and ties break lexicographically", () => {
    const unseen = t("unseen-term");
    const tied = new Map<Term, number>([
      [t("beta"), 100],
      [t("alpha"), 100],
    ]);
    for (const order of permutations([t("beta"), t("alpha")])) {
      const plan = planL0(xqWith({ must: order }), tied);
      expect(plan.gates.map((g) => g.term)).toEqual(["alpha", "beta"]);
    }
    const withUnknown = planL0(xqWith({ must: [t("box"), unseen] }), dfs);
    expect(withUnknown.gates.map((g) => g.term)[0]).toBe("unseen-term");
  });

  it.each([
    { name: "no filters/top", filters: {}, sort: SortOrder.Top, index: "by_term_score" },
    {
      name: "media/top",
      filters: { media: "image" },
      sort: SortOrder.Top,
      index: "by_term_media_score",
      eq: { mediaType: "image" },
    },
    {
      name: "media/latest loses to time",
      filters: { media: "image" },
      sort: SortOrder.Latest,
      index: "by_term_time",
    },
    {
      name: "media/top with since loses to time",
      filters: { media: "image", since: 123 },
      sort: SortOrder.Top,
      index: "by_term_time",
    },
    { name: "since/top", filters: { since: 123 }, sort: SortOrder.Top, index: "by_term_time" },
    { name: "until/top", filters: { until: 456 }, sort: SortOrder.Top, index: "by_term_time" },
    { name: "latest/no filters", filters: {}, sort: SortOrder.Latest, index: "by_term_time" },
    {
      name: "author wins over media+time+latest",
      filters: { authorId: "a1" as AuthorId, media: "image", since: 1, until: 2 },
      sort: SortOrder.Latest,
      index: "by_term_author_time",
      eq: { authorId: "a1" },
    },
  ] as Array<{
    name: string;
    filters: Partial<ReturnType<typeof emptyXQuery>["filters"]>;
    sort: SortOrder;
    index: string;
    eq?: { authorId?: string; mediaType?: string };
  }>)(
    "filter shape $name picks $index regardless of term order",
    ({ filters, sort, index, eq }) => {
      for (const order of permutations([linux, box])) {
        const plan = planL0(
          xqWith({
            must: order,
            sort,
            filters: { ...emptyXQuery().filters, ...filters },
          }),
          dfs,
        );
        for (const gate of plan.gates) {
          expect(gate.index).toBe(index);
          expect(gate.limit).toBe(PER_TERM_CAP);
          // Rows without `eq` pin the absence of the filter, so assert it too.
          expect(gate.eq).toEqual(eq);
        }
      }
    },
  );

  it("uniqueTerms dedups in first-seen order across input permutations", () => {
    expect(uniqueTerms([t("a"), t("b")], [t("b"), t("c")], [t("a")])).toEqual([
      t("a"),
      t("b"),
      t("c"),
    ]);
    // Same multiset in a different split still yields the same first-seen order.
    expect(uniqueTerms([t("c")], [t("a"), t("b"), t("c")])).toEqual([t("c"), t("a"), t("b")]);
  });
});

describe("escalate permutations", () => {
  it.each([0, 1, MIN_RESULTS - 1])("survivors=%i keeps escalating", (survivors) => {
    const xq = xqWith({ must: [t("linux"), t("box")] });
    expect(escalate(planL0(xq, dfs), survivors, xq, dfs)).not.toBeNull();
  });

  it.each([MIN_RESULTS, MIN_RESULTS + 1, 100])("survivors=%i stops the ladder", (survivors) => {
    const xq = xqWith({ must: [t("linux"), t("box")] });
    expect(escalate(planL0(xq, dfs), survivors, xq, dfs)).toBeNull();
  });

  it.each([
    { phrases: [[t("box")]], keep: ["box"] },
    { phrases: [[t("linux")]], keep: ["linux"] },
  ])("L1 protects phrase terms $phrases", ({ phrases, keep }) => {
    const xq = xqWith({ must: [t("linux"), t("box")], phrases });
    const next = escalate(planL0(xq, dfs), 0, xq, dfs)!;
    expect(next.level).toBe("L1");
    expect(next.gates.map((g) => g.term)).toEqual(keep);
  });

  it("fully phrase-protected must jumps straight to L2 union", () => {
    const xq = xqWith({ must: [t("linux"), t("box")], phrases: [[t("box"), t("linux")]] });
    const next = escalate(planL0(xq, dfs), 0, xq, dfs)!;
    expect(next.level).toBe("L2");
    expect(next.gates).toEqual([]);
  });

  it.each([
    {
      name: "author",
      filters: { authorId: "a1" as AuthorId },
      exclude: ["iphone"],
      index: "by_term_author_time",
      eq: { authorId: "a1" },
    },
    {
      name: "media",
      filters: { media: "image" },
      exclude: ["android"],
      index: "by_term_media_score",
      eq: { mediaType: "image" },
    },
    {
      name: "since+until",
      filters: { since: 1, until: 2 },
      exclude: ["iphone", "android"],
      index: "by_term_time",
    },
    {
      name: "author+media+since",
      filters: { authorId: "a1" as AuthorId, media: "video", since: 7 },
      exclude: [],
      index: "by_term_author_time",
      eq: { authorId: "a1" },
    },
  ] as Array<{
    name: string;
    filters: { authorId?: AuthorId; media?: MediaFilter; since?: number; until?: number };
    exclude: string[];
    index: string;
    eq?: { authorId?: string; mediaType?: string };
  }>)("filters/excludes never relax: $name", ({ filters, exclude, index, eq }) => {
    const xq = xqWith({
      must: [t("linux"), t("box")],
      exclude: exclude.map(t),
      filters: { ...emptyXQuery().filters, ...filters },
    });
    let plan: ReadPlan | null = planL0(xq, dfs);
    let steps = 0;
    while (plan !== null && steps < 5) {
      expect([...plan.excludes].sort()).toEqual([...xq.exclude].sort());
      expect(plan.postFilters.since).toBe((filters as { since?: number }).since ?? undefined);
      expect(plan.postFilters.until).toBe((filters as { until?: number }).until ?? undefined);
      for (const read of [...plan.gates, ...plan.unions]) {
        expect(read.index).toBe(index);
        expect(read.eq).toEqual(eq);
      }
      plan = escalate(plan, 0, xq, dfs, [t("prf1")]);
      steps++;
    }
    expect(steps).toBeGreaterThan(1);
  });
});

describe("rerank permutations", () => {
  const base: Candidate = {
    tweetId: "t1",
    tf: new Map([[t("linux"), 1]]),
    matchedVia: "L0",
    likeCount: 0,
    replyCount: 0,
    retweetCount: 0,
    quoteCount: 0,
    propagatedBoost: 0,
    createdAt: 0,
    tokenCount: 20,
    authorAuthority: 1,
    mediaType: "none",
    feedbackVotes: 0,
  };
  const stats = { totalDocs: 100_000, avgTokenCount: 30, dfs };
  const NOW = 1_000_000_000;

  function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i++) {
      const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([xs[i]!, ...tail]);
    }
    return out;
  }

  it("ranking is deterministic across every input permutation", () => {
    const cands: Candidate[] = [0, 10, 100, 5000].map((likeCount, i) => ({
      ...base,
      tweetId: `c${i}`,
      likeCount,
    }));
    const expected = rerank(emptyXQuery(), cands, stats, NOW).map((s) => s.tweetId);
    for (const order of permutations(cands)) {
      expect(rerank(emptyXQuery(), order, stats, NOW).map((s) => s.tweetId)).toEqual(expected);
    }
    expect(expected[0]).toBe("c3");
  });

  it.each([
    { axis: "likeCount", viral: { likeCount: 100 } },
    { axis: "replyCount", viral: { replyCount: 100 } },
    { axis: "retweetCount", viral: { retweetCount: 100 } },
    { axis: "quoteCount", viral: { quoteCount: 100 } },
    { axis: "propagatedBoost", viral: { propagatedBoost: 100 } },
  ])("engagement axis $axis alone outranks quiet", ({ viral }) => {
    const cands = [
      { ...base, tweetId: "quiet" },
      { ...base, tweetId: "viral", ...viral },
    ];
    for (const order of [cands, [...cands].reverse()]) {
      expect(rerank(emptyXQuery(), order, stats, NOW)[0]!.tweetId).toBe("viral");
    }
  });

  it.each([
    { votes: -50, bucket: "floor" },
    { votes: -6, bucket: "floor" },
    { votes: -WEIGHTS.fbClamp, bucket: "floor" },
    { votes: 0, bucket: "zero" },
    { votes: WEIGHTS.fbClamp, bucket: "cap" },
    { votes: 6, bucket: "cap" },
    { votes: 50, bucket: "cap" },
  ])("feedback votes=$votes lands in $bucket", ({ votes, bucket }) => {
    const score = rerank(emptyXQuery(), [{ ...base, feedbackVotes: votes }], stats, NOW)[0]!.score;
    const floor = rerank(emptyXQuery(), [{ ...base, feedbackVotes: -50 }], stats, NOW)[0]!.score;
    const zero = rerank(emptyXQuery(), [{ ...base, feedbackVotes: 0 }], stats, NOW)[0]!.score;
    const cap = rerank(emptyXQuery(), [{ ...base, feedbackVotes: 50 }], stats, NOW)[0]!.score;
    const expected = bucket === "floor" ? floor : bucket === "cap" ? cap : zero;
    expect(score).toBe(expected);
  });

  it("feedback clamp is monotone: down < neutral < up", () => {
    const score = (v: number) =>
      rerank(emptyXQuery(), [{ ...base, feedbackVotes: v }], stats, NOW)[0]!.score;
    expect(score(-WEIGHTS.fbClamp)).toBeLessThan(score(0));
    expect(score(0)).toBeLessThan(score(WEIGHTS.fbClamp));
  });

  it.each(["retweetOfTweetId", "quotedTweetId", "sourceTweetId"] as const)(
    "chain edge %s dedups to the best representative in either order",
    (edge) => {
      const original: Candidate = { ...base, tweetId: "original", likeCount: 10 };
      const derived: Candidate = {
        ...base,
        tweetId: "derived",
        likeCount: 0,
        [edge]: "original" as TweetId,
      };
      for (const order of [
        [original, derived],
        [derived, original],
      ]) {
        expect(rerank(emptyXQuery(), order, stats, NOW).map((s) => s.tweetId)).toEqual([
          "original",
        ]);
      }
      // Best representative wins even when the derived post has more engagement.
      const hotDerived: Candidate = { ...derived, likeCount: 5000 };
      for (const order of [
        [original, hotDerived],
        [hotDerived, original],
      ]) {
        const out = rerank(emptyXQuery(), order, stats, NOW);
        expect(out).toHaveLength(1);
        expect(out[0]!.tweetId).toBe("derived");
      }
    },
  );

  it("fit bonuses stack monotonically: plain < should < media < both", () => {
    const xq = xqWith({
      should: [t("cheap")],
      filters: { ...emptyXQuery().filters, media: "image" },
    });
    const score = (c: Candidate) => rerank(xq, [c], stats, NOW)[0]!.score;
    const plain = score(base);
    const shouldOnly = score({
      ...base,
      tf: new Map([
        [t("linux"), 1],
        [t("cheap"), 1],
      ]),
    });
    const mediaOnly = score({ ...base, mediaType: "image" });
    const both = score({
      ...base,
      tf: new Map([
        [t("linux"), 1],
        [t("cheap"), 1],
      ]),
      mediaType: "image",
    });
    expect(shouldOnly).toBeGreaterThan(plain);
    expect(mediaOnly).toBeGreaterThan(shouldOnly);
    expect(both).toBeGreaterThan(mediaOnly);
  });

  it.each([
    { tf: [[t("linux"), 1]] as Array<[Term, number]>, covers: false },
    {
      tf: [
        [t("linux"), 1],
        [t("box"), 1],
      ] as Array<[Term, number]>,
      covers: true,
    },
  ])("phrase coverage tf=$tf covers=$covers", ({ tf, covers }) => {
    const xq = xqWith({ phrases: [[t("linux"), t("box")]] });
    const covered = rerank(xq, [{ ...base, tf: new Map(tf) }], stats, NOW)[0]!;
    const bare = rerank(xq, [{ ...base, tf: new Map([[t("zzz"), 1]]) }], stats, NOW)[0]!;
    // One unconditional assertion, with the comparison kept in the message.
    const relation =
      covered.score > bare.score ? "greater" : covered.score === bare.score ? "equal" : "less";
    expect(relation).toBe(covers ? "greater" : "equal");
  });
});

// Deterministic PRNG (mulberry32) for seeded property tests: the same seed
// always yields the same "random" inputs, so failures reproduce exactly.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let z = Math.imul(a ^ (a >>> 15), 1 | a);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(rand: () => number, xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("plan/rerank strong permutations (seeded properties)", () => {
  const VOCAB = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map(t);

  function randomDfMap(rand: () => number): Map<Term, number> {
    const map = new Map<Term, number>();
    for (const term of VOCAB) {
      const roll = rand();
      // Skewed: some terms missing (df 0 = rarest), some tied, most spread out.
      if (roll < 0.2) continue;
      map.set(term, Math.floor(rand() * 4) * 1000 + Math.floor(rand() * 50));
    }
    return map;
  }

  it.each([1, 7, 42, 1337, 99991])(
    "planL0 matches the rarest-first reference model (seed %i)",
    (seed) => {
      const rand = rng(seed);
      for (let trial = 0; trial < 25; trial++) {
        const dfMap = randomDfMap(rand);
        const must = shuffled(rand, VOCAB).slice(0, 1 + Math.floor(rand() * (VOCAB.length - 1)));
        const aspects = shuffled(rand, VOCAB)
          .slice(0, Math.floor(rand() * 3))
          .map((s) => t(`~${s}`));
        const plan = planL0(xqWith({ must: shuffled(rand, must), aspects }), dfMap);
        // Reference: unique must+aspects sorted by (df ?? 0), ties lexicographic.
        const expected = [...new Set([...must, ...aspects])].sort((a, b) => {
          const d = (dfMap.get(a) ?? 0) - (dfMap.get(b) ?? 0);
          return d !== 0 ? d : a.localeCompare(b);
        });
        expect(plan.gates.map((g) => g.term)).toEqual(expected);
        for (const gate of plan.gates) expect(gate.limit).toBe(PER_TERM_CAP);
      }
    },
  );

  it.each([1, 7, 42])(
    "full ladder walk keeps levels ordered and filters frozen (seed %i)",
    (seed) => {
      const rand = rng(seed);
      const filterShapes: Array<Partial<XQueryFilters>> = [
        {},
        { authorId: "a1" as AuthorId },
        { media: "image" },
        { since: 100, until: 200 },
        { authorId: "a9" as AuthorId, media: "video", since: 5 },
      ];
      for (let trial = 0; trial < 15; trial++) {
        const dfMap = randomDfMap(rand);
        const must = shuffled(rand, VOCAB).slice(0, 2 + Math.floor(rand() * 3));
        const filters = filterShapes[Math.floor(rand() * filterShapes.length)]!;
        const exclude = shuffled(rand, VOCAB).slice(0, 2);
        const xq = xqWith({
          must,
          should: shuffled(rand, VOCAB).slice(0, 2),
          exclude,
          filters: { ...emptyXQuery().filters, ...filters },
        });
        const levels: string[] = [];
        let plan: ReadPlan | null = planL0(xq, dfMap);
        levels.push(plan.level);
        for (let step = 0; step < 6 && plan !== null; step++) {
          expect([...plan.excludes].sort()).toEqual([...exclude].sort());
          expect(plan.postFilters.since).toBe((filters as { since?: number }).since ?? undefined);
          expect(plan.postFilters.until).toBe((filters as { until?: number }).until ?? undefined);
          plan = escalate(plan, 0, xq, dfMap, [t("prf-a"), t("prf-b")]);
          if (plan !== null) levels.push(plan.level);
        }
        // Levels must follow the ladder order with no backward steps; L1 may
        // repeat once (at most two drops) but nothing else repeats. The walk
        // always starts at L0 by construction (levels[0] is the L0 plan).
        const order = ["L0", "L1", "L2", "L3"];
        const idx = levels.map((l) => order.indexOf(l));
        expect(levels[0]).toBe("L0");
        expect([...idx].sort((a, b) => a - b)).toEqual(idx);
        const counts = new Map<string, number>();
        for (const l of levels) counts.set(l, (counts.get(l) ?? 0) + 1);
        for (const [level, count] of counts) {
          expect(count).toBeLessThanOrEqual(level === "L1" ? 2 : 1);
        }
      }
    },
  );

  it.each([1, 7, 42, 1337])(
    "rerank is shuffle-invariant over random candidate sets (seed %i)",
    (seed) => {
      const rand = rng(seed);
      for (let trial = 0; trial < 15; trial++) {
        const n = 2 + Math.floor(rand() * 5);
        const cands: Candidate[] = Array.from({ length: n }, (_, i) => ({
          tweetId: `r${trial}-${i}`,
          tf: new Map([[t("linux"), 1 + Math.floor(rand() * 3)]]),
          matchedVia: "L0" as const,
          likeCount: Math.floor(rand() * 5000),
          replyCount: Math.floor(rand() * 200),
          retweetCount: Math.floor(rand() * 500),
          quoteCount: Math.floor(rand() * 100),
          propagatedBoost: Math.floor(rand() * 50),
          createdAt: Math.floor(rand() * 1_000_000_000),
          tokenCount: 5 + Math.floor(rand() * 40),
          authorAuthority: rand() * 10,
          mediaType: rand() < 0.3 ? "image" : "none",
          feedbackVotes: Math.floor(rand() * 21) - 10,
        }));
        const stats = { totalDocs: 100_000, avgTokenCount: 30, dfs };
        const NOW = 1_000_000_000;
        const expected = rerank(emptyXQuery(), cands, stats, NOW).map((s) => s.tweetId);
        for (let s = 0; s < 5; s++) {
          const order = shuffled(rand, cands);
          expect(rerank(emptyXQuery(), order, stats, NOW).map((r) => r.tweetId)).toEqual(expected);
        }
      }
    },
  );
});

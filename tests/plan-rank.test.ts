// Planner + reranker unit tests: bounded reads, rarest-first ordering, the
// escalation ladder's invariants (filters never relax; only terms do), and
// deterministic scoring.

import { describe, expect, test } from "vitest";
import { escalate, planL0, MIN_RESULTS, PER_TERM_CAP } from "../convex/engine/plan";
import { rerank, type Candidate } from "../convex/engine/rank";
import { emptyXQuery } from "../convex/engine/xquery";
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

describe("planL0", () => {
  test("gates are rarest-first with mandatory limits", () => {
    const plan = planL0(xqWith({ must: [t("box"), t("linux")], aspects: [t("~price")] }), dfs);
    expect(plan.gates.map((g) => g.term)).toEqual(["linux", "box", "~price"]);
    for (const g of plan.gates) {
      expect(g.limit).toBe(PER_TERM_CAP);
      expect(g.index).toBe("by_term_score");
    }
  });

  test("filter shape picks the index", () => {
    const author = planL0(
      xqWith({ must: [t("linux")], filters: { ...emptyXQuery().filters, authorId: "a1" as AuthorId } }),
      dfs,
    );
    expect(author.gates[0]!.index).toBe("by_term_author_time");
    expect(author.gates[0]!.eq).toEqual({ authorId: "a1" });

    const media = planL0(
      xqWith({ must: [t("linux")], filters: { ...emptyXQuery().filters, media: "image" } }),
      dfs,
    );
    expect(media.gates[0]!.index).toBe("by_term_media_score");

    const latest = planL0(xqWith({ must: [t("linux")], sort: "latest" }), dfs);
    expect(latest.gates[0]!.index).toBe("by_term_time");
  });
});

describe("escalate", () => {
  const xq = xqWith({ must: [t("linux"), t("box")], should: [t("cheap")], aspects: [t("~price")] });

  test("enough survivors stops the ladder", () => {
    expect(escalate(planL0(xq, dfs), MIN_RESULTS, xq, dfs)).toBeNull();
  });

  test("L1 protects phrase terms even when they also appear in must", () => {
    const phrase = xqWith({ must: [t("linux"), t("box")], phrases: [[t("box")]] });
    const next = escalate(planL0(phrase, dfs), 0, phrase, dfs)!;
    expect(next.gates.map((gate) => gate.term)).toEqual(["box"]);
  });

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

  test("filters and excludes never relax on the way down", () => {
    const filtered = xqWith({
      must: [t("linux"), t("box")],
      exclude: [t("iphone")],
      filters: { ...emptyXQuery().filters, authorId: "a1" as AuthorId, since: 123 },
    });
    let plan: ReturnType<typeof escalate> = planL0(filtered, dfs);
    for (let i = 0; i < 4 && plan !== null; i++) {
      expect(plan.excludes).toEqual(["iphone"]);
      expect(plan.postFilters.since).toBe(123);
      for (const read of [...plan.gates, ...plan.unions]) {
        expect(read.index).toBe("by_term_author_time");
        expect(read.eq).toEqual({ authorId: "a1" });
      }
      plan = escalate(plan, 0, filtered, dfs, [t("prf1")]);
    }
  });

  test("L2 -> L3 only with mined PRF terms, then stops", () => {
    const l2 = escalate(planL0(xqWith({ must: [t("linux")] }), dfs), 0, xqWith({ must: [t("linux")] }), dfs)!;
    expect(l2.level).toBe("L2");
    expect(escalate(l2, 0, xqWith({ must: [t("linux")] }), dfs)).toBeNull();
    const l3 = escalate(l2, 0, xqWith({ must: [t("linux")] }), dfs, [t("kernel")])!;
    expect(l3.level).toBe("L3");
    expect(l3.unions.map((u) => u.term)).toContain("kernel");
    expect(escalate(l3, 0, xqWith({ must: [t("linux")] }), dfs, [t("kernel")])).toBeNull();
  });
});

describe("rerank", () => {
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

  test("deterministic and engagement-sensitive", () => {
    const cands = [
      { ...base, tweetId: "quiet" },
      { ...base, tweetId: "viral", likeCount: 5000, quoteCount: 100 },
    ];
    const a = rerank(emptyXQuery(), cands, stats, NOW);
    const b = rerank(emptyXQuery(), [...cands].reverse(), stats, NOW);
    expect(a.map((s) => s.tweetId)).toEqual(b.map((s) => s.tweetId));
    expect(a[0]!.tweetId).toBe("viral");
  });

  test("feedback is clamped and moves the score", () => {
    const up = rerank(emptyXQuery(), [{ ...base, feedbackVotes: 50 }], stats, NOW)[0]!;
    const capped = rerank(emptyXQuery(), [{ ...base, feedbackVotes: 5 }], stats, NOW)[0]!;
    const down = rerank(emptyXQuery(), [{ ...base, feedbackVotes: -50 }], stats, NOW)[0]!;
    expect(up.score).toBe(capped.score);
    expect(up.score).toBeGreaterThan(down.score);
  });

  test("RT chains dedup to the best representative", () => {
    const scored = rerank(
      emptyXQuery(),
      [
        { ...base, tweetId: "original", likeCount: 10 },
        { ...base, tweetId: "rt", retweetOfTweetId: "original" as TweetId, likeCount: 0 },
      ],
      stats,
      NOW,
    );
    expect(scored.map((s) => s.tweetId)).toEqual(["original"]);
  });

  test("should-term and media fits add score", () => {
    const xq = xqWith({ should: [t("cheap")], filters: { ...emptyXQuery().filters, media: "image" } });
    const plain = rerank(xq, [base], stats, NOW)[0]!;
    const fit = rerank(
      xq,
      [{ ...base, tf: new Map([[t("linux"), 1], [t("cheap"), 1]]), mediaType: "image" }],
      stats,
      NOW,
    )[0]!;
    expect(fit.score).toBeGreaterThan(plain.score);
  });
});

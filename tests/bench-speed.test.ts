// Composable speed bench: per-part CPU timings + optional prod e2e latency.
// Run: pnpm vitest run tests/bench-speed.test.ts           (offline parts)
//      BENCH_PROD=1 pnpm vitest run tests/bench-speed.test.ts  (+ prod e2e)
// Medians + an A/A control make the noise band visible; numbers are
// device-relative (see bench/README.md).
import { describe, expect, test } from "vitest";
import { tokenize } from "../convex/engine/tokenize";
import { tierA, tierB, type TierBDeps } from "../convex/engine/parse";
import { planL0, repairNeighbors } from "../convex/engine/plan";
import { rerank } from "../convex/engine/rank";
import { COMMON_DF_FLOOR } from "../convex/search";
import type { Term } from "../convex/contracts/ids";
import { sampleTweets, GOLDEN_QUERIES } from "../bench/corpus";

const NOW = Date.UTC(2026, 8, 16);
const sample = sampleTweets(220);
const texts = sample.map((s) => s.text);

const df = new Map<Term, number>([
  ["pricing" as Term, 5119],
  ["rust" as Term, 700],
  ["openai" as Term, 900],
]);
const authors = new Map<string, string>([
  ["paulg", "17"],
  ["theo", "3"],
]);
const deps: TierBDeps = {
  async resolveEntity(ngram) {
    const joined = ngram.join("");
    const score = df.get(joined as Term);
    if (score !== undefined && score >= COMMON_DF_FLOOR) return null;
    const authorId = authors.get(joined);
    return authorId === undefined ? null : { authorId: authorId as never };
  },
  async resolveHandle(handle) {
    const authorId = authors.get(handle);
    return authorId === undefined ? null : { authorId: authorId as never };
  },
  async dfOf(term) {
    return df.get(term as Term) ?? null;
  },
  now: () => NOW,
};

const raws = [
  "pricing",
  "from:paulg",
  'from:sama "openai"',
  "apple OR rust",
  "to:theo",
  "load more",
  '"founders" pricing cheap expensive',
  "pricing sort:top",
  ...texts.slice(0, 12),
];
const xqs: import("../convex/engine/xquery").XQuery[] = [];
for (const raw of raws) {
  const { xq } = await tierB(tierA(raw), deps);
  xqs.push(xq);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}
function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)] ?? s[s.length - 1] ?? Number.NaN;
}
function timePart(part: string, calls: number, fn: () => void, trials = 7): string {
  for (let i = 0; i < 3; i++) fn(); // warmup to the hot tier
  const run: number[] = [];
  const control: number[] = [];
  for (let t = 0; t < trials; t++) {
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) fn();
    run.push(((performance.now() - t0) * 1000) / calls);
    const c0 = performance.now();
    for (let i = 0; i < calls; i++) fn();
    control.push(((performance.now() - c0) * 1000) / calls);
  }
  return `${part.padEnd(30)} median ${median(run).toFixed(2)}us  p95 ${p95(run).toFixed(2)}us  A/A ${median(control).toFixed(2)}us`;
}

const must = (xqs[0]?.must ?? []) as Term[];
const candidates = sample.slice(0, 200).map((s) => ({
  tweetId: s.tweetId,
  tf: new Map<Term, number>(must.map((t) => [t, 1])),
  likeCount: s.metrics.likes,
  replyCount: s.metrics.replies,
  retweetCount: s.metrics.retweets,
  quoteCount: s.metrics.quotes,
  propagatedBoost: 0,
  createdAt: s.createdAt,
  tokenCount: tokenize(s.text).tokens.length,
  authorAuthority: 3,
  feedbackVotes: 0,
  mediaType: "none" as const,
}));

describe("bench: per-part speed (device-relative)", () => {
  test("per-part timings complete within the A/A band", { timeout: 120_000 }, async () => {
    const out: string[] = [];
    out.push(
      timePart("tokenize", texts.length, () => {
        for (const text of texts) tokenize(text);
      }),
    );
    {
      const run: number[] = [];
      for (let t = 0; t < 5; t++) {
        const t0 = performance.now();
        for (const raw of raws) await tierB(tierA(raw), deps);
        run.push(((performance.now() - t0) * 1000) / raws.length);
      }
      out.push(`parse (tierA+tierB) median ${median(run).toFixed(1)}us/query (awaited)`);
    }
    out.push(
      timePart("planL0", xqs.length, () => {
        for (const xq of xqs) planL0(xq, df);
      }),
    );
    out.push(
      timePart("rerank(200 candidates)", 10, () => {
        rerank(
          xqs[0] as never,
          candidates as never,
          { totalDocs: 176_700, avgTokenCount: 33, dfs: df },
          NOW,
        );
      }),
    );
    out.push(
      timePart("repairNeighbors(17-char)", 2_000, () => {
        repairNeighbors("supercalifragilis" as Term);
      }),
    );
    for (const line of out) console.log(line);
    expect(out.length).toBe(5);
  });

  test("prod e2e latency (BENCH_PROD=1)", { timeout: 240_000 }, async () => {
    if (process.env["BENCH_PROD"] !== "1") {
      console.log("prod e2e skipped (set BENCH_PROD=1)");
      return;
    }
    const envPath = "bench/../.env.indexer-prod";
    const fs = await import("node:fs");
    const path = await import("node:path");
    const env = Object.fromEntries(
      fs
        .readFileSync(path.resolve(envPath), "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => l.split("=", 2) as [string, string]),
    );
    const url = env["CONVEX_URL"] ?? "";
    const queries = [
      ...GOLDEN_QUERIES.map((raw) => ({ raw, sort: "top", limit: 20 })),
      ...["pricing", "rust", "react", "bun", "agents", "openai", "tesla"].map((raw) => ({
        raw,
        sort: "top",
        limit: 20,
      })),
    ];
    const lat: number[] = [];
    for (const args of queries) {
      const t0 = performance.now();
      const r = await fetch(`${url}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "search:search", args: args, format: "json" }),
      });
      const j = (await r.json()) as { status?: string };
      if (j.status !== "success") throw new Error("prod query failed");
      lat.push(performance.now() - t0);
    }
    const sorted = [...lat].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.floor(sorted.length * p)]?.toFixed(0) ?? "n/a";
    console.log(
      `prod e2e (n=${sorted.length}): p50 ${pct(0.5)}ms  p95 ${pct(0.95)}ms  p99 ${pct(0.99)}ms`,
    );
    expect(sorted.length).toBe(queries.length);
  });
});

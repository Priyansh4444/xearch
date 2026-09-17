// Composable bench corpus: a seeded, reproducible sample of the REAL corpus
// (ingress JSONL the pipeline produces). Nothing here contacts Convex.
import fs from "node:fs";
import path from "node:path";

export interface SampleTweet {
  tweetId: string;
  authorId: string;
  authorHandle: string;
  text: string;
  createdAt: number;
  metricsAt: number;
  metrics: { likes: number; retweets: number; quotes: number; replies: number };
  postings: string[];
}

/** Deterministic LCG so runs are comparable across machines. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** True when a real corpus exists on this machine (CI usually has none). */
export function hasCorpus(): boolean {
  return RECORD_PATHS.some((p) => fs.existsSync(p));
}

/** Scan the real corpus files (read-only) and return up to `n` random tweets. */
export function sampleTweets(n: number, seed = 1337): SampleTweet[] {
  const rand = prng(seed);
  const pool: SampleTweet[] = [];
  for (const file of RECORD_FILES()) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      interface Rec {
        kind: string;
        id: string;
        authorId: string;
        text: string;
        createdAt: number;
        metricsAt: number;
        metrics?: Record<string, number>;
      }
      let rec: Rec;
      try {
        rec = JSON.parse(trimmed) as Rec;
      } catch {
        continue;
      }
      if (rec["kind"] !== "tweet") continue;
      const m = rec["metrics"] ?? {};
      const text = rec["text"];
      if (text.length === 0) continue;
      // Seeded swap-sample: once the pool is over the cap, replace entries at
      // random so every record has a small, reproducible chance of appearing.
      const item: SampleTweet = {
        tweetId: rec["id"],
        authorId: rec["authorId"],
        authorHandle: "",
        text,
        createdAt: rec["createdAt"],
        metricsAt: rec["metricsAt"],
        metrics: {
          likes: m["likes"] ?? 0,
          retweets: m["retweets"] ?? 0,
          quotes: m["quotes"] ?? 0,
          replies: m["replies"] ?? 0,
        },
        postings: [],
      };
      if (pool.length < n) {
        pool.push(item);
      } else {
        const j = Math.floor(rand() * pool.length);
        if (rand() < n / (pool.length + n)) pool[j] = item;
      }
    }
  }
  return pool.slice(0, n);
}

function RECORD_FILES(): string[] {
  return RECORD_PATHS.filter((p) => fs.existsSync(p));
}

const RECORD_PATHS = [
  "data/old/2026-09-03T06-45-44Z-full/ingress/records.jsonl",
  "data/old/2026-09-16T08-43-18Z-addendum-0916/ingress/records.jsonl",
  "data/old/2026-09-16T08-57-38Z-expansion-0916/ingress/records.jsonl",
  "data/old/2026-09-16T22-07-06Z-influencers-0916/ingress/records.jsonl",
  "data/old/2026-09-17T02-59-58Z-influencer-no-replies/ingress/records.jsonl",
  "data/old/2026-09-17T03-02-44Z-influencers-batch2/ingress/records.jsonl",
].map((p) => path.resolve(import.meta.dirname, "..", p));

/** Realistic query shapes sampled from the corpus vocabulary + the golden set. */
export const GOLDEN_QUERIES = [
  "pricing",
  "from:paulg",
  "from:elonmusk",
  'from:sama "openai"',
  'from:theo "typescript"',
  "load more",
  "to:theo",
  '"founders" pricing cheap expensive',
  "react server components",
  "from:@sama",
];

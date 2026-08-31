// Phase-2 reranker + RRF fusion (DESIGN §6). Pure functions over hydrated rows.
// All constants live in WEIGHTS so tuning is a diff, not a hunt (RISKS K4).

import type { XQuery } from "./xquery";

export const WEIGHTS = {
  rel: 0.35,
  eng: 0.2,
  auth: 0.1,
  rec: 0.15,
  fb: 0.1,
  fit: 0.1,
  // BM25, near-binary per TREC Microblog findings (tf & length norm hurt tweets):
  bm25_k1: 0.3,
  bm25_b: 0.0,
  // engagement weights: like/reply/RT/quote — quotes highest (effortful amplification)
  w_like: 1,
  w_reply: 2,
  w_rt: 3,
  w_quote: 4,
  recencyTauMsTop: 48 * 3600 * 1000,
  recencyTauMsLatest: 6 * 3600 * 1000,
  fbClamp: 5,
} as const;

export interface Candidate {
  tweetId: string;
  tf: Map<string, number>; // per matched term, from postings
  matchedVia: "L0" | "L1" | "L2" | "L3" | "L4";
  // hydrated at rerank time (live data — the two-phase split, §6.1):
  likeCount: number;
  replyCount: number;
  retweetCount: number;
  quoteCount: number;
  propagatedBoost: number;
  createdAt: number;
  tokenCount: number;
  authorAuthority: number;
  mediaType: string;
  feedbackVotes: number; // Σ votes for (queryKey, tweet), pre-clamped by caller? no — clamped here
}

export interface Scored {
  tweetId: string;
  score: number;
  matchedVia: Candidate["matchedVia"];
  parts: Record<string, number>; // per-signal contributions — the trace UI + evals read this
}

/** BM25 with near-binary parameters; df/N from the terms table snapshot. */
export function bm25(
  tf: number,
  df: number,
  totalDocs: number,
  tokenCount: number,
  avgTokenCount: number,
): number {
  const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
  const { bm25_k1: k1, bm25_b: b } = WEIGHTS;
  const denom = tf + k1 * (1 - b + (b * tokenCount) / avgTokenCount);
  return idf * ((tf * (k1 + 1)) / (denom === 0 ? 1 : denom));
}

export function rerank(
  xq: XQuery,
  candidates: Candidate[],
  stats: { totalDocs: number; avgTokenCount: number; dfs: Map<string, number> },
  now: number,
): Scored[] {
  // TODO(implement): per DESIGN §6.1 —
  //   rel  = Σ_terms bm25(...)
  //   eng  = log1p(w_like·likes + w_reply·replies + w_rt·rts + w_quote·quotes + propagatedBoost) / z
  //   auth = authority / z
  //   rec  = exp(-(now - createdAt) / tau(sort))
  //   fb   = clamp(feedbackVotes, ±fbClamp) / fbClamp
  //   fit  = media match + phrase hit + should-polarity hit (§4.6)
  //   z-normalize eng/auth over the candidate set (not global — cheap and stable).
  // Then: dedup quote/RT chains to best representative (K5), sort desc.
  throw new Error("not implemented: rerank");
}

/** Reciprocal Rank Fusion across ranked lists (lexical, paraphrases, vectors). */
export function rrfFuse(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

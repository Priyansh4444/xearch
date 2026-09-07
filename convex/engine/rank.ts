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
  /** RT/quote chain edges for representative dedup (K5). Source-id space, so a
   * retweet collapses with its original via sourceTweetId. */
  retweetOfTweetId?: string;
  quotedTweetId?: string;
  sourceTweetId?: string;
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
  if (candidates.length === 0) return [];
  const tau = xq.sort === "latest" ? WEIGHTS.recencyTauMsLatest : WEIGHTS.recencyTauMsTop;

  // Raw per-signal values first; eng/auth/rel normalize over the candidate set
  // (max-normalization: cheap, stable, and immune to degenerate variance).
  const raw = candidates.map((c) => {
    let rel = 0;
    for (const [term, tf] of c.tf) {
      rel += bm25(
        tf,
        stats.dfs.get(term) ?? 0,
        stats.totalDocs,
        c.tokenCount,
        stats.avgTokenCount,
      );
    }
    const eng = Math.log1p(
      WEIGHTS.w_like * c.likeCount +
        WEIGHTS.w_reply * c.replyCount +
        WEIGHTS.w_rt * c.retweetCount +
        WEIGHTS.w_quote * c.quoteCount +
        Math.max(0, c.propagatedBoost),
    );
    return { rel, eng, auth: Math.max(0, c.authorAuthority) };
  });
  const z = {
    rel: Math.max(...raw.map((r) => r.rel), 1e-9),
    eng: Math.max(...raw.map((r) => r.eng), 1e-9),
    auth: Math.max(...raw.map((r) => r.auth), 1e-9),
  };

  const scored: Scored[] = candidates.map((c, i) => {
    const rel = raw[i]!.rel / z.rel;
    const eng = raw[i]!.eng / z.eng;
    const auth = raw[i]!.auth / z.auth;
    const rec = Math.exp(-Math.max(0, now - c.createdAt) / tau);
    const fb =
      Math.max(-WEIGHTS.fbClamp, Math.min(WEIGHTS.fbClamp, c.feedbackVotes)) /
      WEIGHTS.fbClamp;
    const fit = fitBonus(xq, c);
    const parts = {
      rel: WEIGHTS.rel * rel,
      eng: WEIGHTS.eng * eng,
      auth: WEIGHTS.auth * auth,
      rec: WEIGHTS.rec * rec,
      fb: WEIGHTS.fb * fb,
      fit: WEIGHTS.fit * fit,
    };
    return {
      tweetId: c.tweetId,
      score: parts.rel + parts.eng + parts.auth + parts.rec + parts.fb + parts.fit,
      matchedVia: c.matchedVia,
      parts,
    };
  });

  // Dedup quote/RT chains to the best representative (K5: one hop, no traversal).
  const byId = new Map(candidates.map((c) => [c.tweetId, c]));
  function compare(a: Scored, b: Scored): number {
    if (xq.sort === "latest") {
      const time = byId.get(b.tweetId)!.createdAt - byId.get(a.tweetId)!.createdAt;
      if (time !== 0) return time;
    }
    return b.score - a.score || a.tweetId.localeCompare(b.tweetId);
  }
  const best = new Map<string, Scored>();
  for (const s of scored) {
    const c = byId.get(s.tweetId)!;
    const key = c.retweetOfTweetId ?? c.quotedTweetId ?? c.sourceTweetId ?? s.tweetId;
    const prior = best.get(key);
    if (prior === undefined || compare(s, prior) < 0) best.set(key, s);
  }

  return [...best.values()].sort(compare);
}

/** Intent bonuses (§4.6): media match, phrase coverage, should-polarity hits. */
function fitBonus(xq: XQuery, c: Candidate): number {
  let fit = 0;
  if (
    (xq.filters.media !== null && c.mediaType === xq.filters.media) ||
    (xq.intent === "media" && c.mediaType !== "none")
  ) {
    fit += 0.5;
  }
  if (
    xq.phrases.length > 0 &&
    xq.phrases.every((p) => p.every((t) => c.tf.has(t)))
  ) {
    fit += 0.3; // serving verifies adjacency before reranking
  }
  if (xq.should.length > 0 && xq.should.some((t) => c.tf.has(t))) {
    fit += 0.2;
  }
  return fit;
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

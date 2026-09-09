// Phase-2 reranker + RRF fusion (DESIGN §6). Pure functions over hydrated rows.
// All constants live in WEIGHTS so tuning is a diff, not a hunt (RISKS K4).

import { MediaType } from "../contracts/media";
import type { Term, TweetId } from "../contracts/ids";
import { LadderLevel } from "./plan";
import { Intent, SortOrder, type XQuery } from "./xquery";

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
  /** Convex doc `_id` (postings denormalize it) — NOT the source tweet id. */
  tweetId: string;
  tf: Map<Term, number>; // per matched term, from postings
  matchedVia: Exclude<LadderLevel, "L5">;
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
  retweetOfTweetId?: TweetId | undefined;
  quotedTweetId?: TweetId | undefined;
  sourceTweetId?: TweetId | undefined;
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
  stats: { totalDocs: number; avgTokenCount: number; dfs: Map<Term, number> },
  now: number,
): Scored[] {
  if (candidates.length === 0) return [];
  const tau = xq.sort === SortOrder.Latest ? WEIGHTS.recencyTauMsLatest : WEIGHTS.recencyTauMsTop;

  // Raw per-signal values first; eng/auth/rel normalize over the candidate set
  // (max-normalization: cheap, stable, and immune to degenerate variance).
  // One fused pass: values AND their maxima, with no intermediate array of
  // signal objects and no per-signal closures. The previous shape —
  // `candidates.map(...)` plus 3× `Math.max(...rows.map(pick))` — allocated an
  // object per candidate and four throwaway arrays per rerank (see bytecode).
  const rels: number[] = Array.from({ length: candidates.length });
  const engs: number[] = Array.from({ length: candidates.length });
  const auths: number[] = Array.from({ length: candidates.length });
  let zRel = 1e-9;
  let zEng = 1e-9;
  let zAuth = 1e-9;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    let rel = 0;
    for (const [term, tf] of c.tf) {
      rel += bm25(tf, stats.dfs.get(term) ?? 0, stats.totalDocs, c.tokenCount, stats.avgTokenCount);
    }
    const eng = Math.log1p(
      WEIGHTS.w_like * c.likeCount +
        WEIGHTS.w_reply * c.replyCount +
        WEIGHTS.w_rt * c.retweetCount +
        WEIGHTS.w_quote * c.quoteCount +
        Math.max(0, c.propagatedBoost),
    );
    const auth = Math.max(0, c.authorAuthority);
    rels[i] = rel;
    engs[i] = eng;
    auths[i] = auth;
    if (rel > zRel) zRel = rel;
    if (eng > zEng) zEng = eng;
    if (auth > zAuth) zAuth = auth;
  }
  const z = { rel: zRel, eng: zEng, auth: zAuth };

  const scored: Scored[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const rel = rels[i]! / z.rel;
    const eng = engs[i]! / z.eng;
    const auth = auths[i]! / z.auth;
    const rec = Math.exp(-Math.max(0, now - c.createdAt) / tau);
    const fb =
      Math.max(-WEIGHTS.fbClamp, Math.min(WEIGHTS.fbClamp, c.feedbackVotes)) / WEIGHTS.fbClamp;
    const fit = fitBonus(xq, c);
    const parts = {
      rel: WEIGHTS.rel * rel,
      eng: WEIGHTS.eng * eng,
      auth: WEIGHTS.auth * auth,
      rec: WEIGHTS.rec * rec,
      fb: WEIGHTS.fb * fb,
      fit: WEIGHTS.fit * fit,
    };
    scored.push({
      tweetId: c.tweetId,
      score: parts.rel + parts.eng + parts.auth + parts.rec + parts.fb + parts.fit,
      matchedVia: c.matchedVia,
      parts,
    });
  }

  // Dedup quote/RT chains to the best representative (K5: one hop, no traversal).
  const byId = new Map<string, Candidate>();
  for (const c of candidates) byId.set(c.tweetId, c);
  function compare(a: Scored, b: Scored): number {
    if (xq.sort === SortOrder.Latest) {
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
    (xq.intent === Intent.Media && c.mediaType !== MediaType.None)
  ) {
    fit += 0.5;
  }
  if (xq.phrases.length > 0 && coversAllPhrases(xq.phrases, c.tf)) {
    fit += 0.3; // serving verifies adjacency before reranking
  }
  if (xq.should.length > 0 && hasAnyTerm(xq.should, c.tf)) {
    fit += 0.2;
  }
  return fit;
}

/** Every phrase fully covered by the candidate's matched terms. Loops, not
 * nested `.every` closures — this runs per candidate (≤200/query). */
function coversAllPhrases(phrases: Term[][], tf: Map<Term, number>): boolean {
  for (const phrase of phrases) {
    for (const term of phrase) {
      if (!tf.has(term)) return false;
    }
  }
  return true;
}

/** Any soft term among the candidate's matched terms. */
function hasAnyTerm(terms: Term[], tf: Map<Term, number>): boolean {
  for (const term of terms) {
    if (tf.has(term)) return true;
  }
  return false;
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

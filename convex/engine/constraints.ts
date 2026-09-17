import { tokenize, isStopword } from "./tokenize";
import { adjacentBigrams } from "./bigrams";
import { mapAspects } from "./parse";
import type { Term } from "../contracts/ids";
import type { XQuery } from "./xquery";

export const MAX_QUERY_LENGTH = 512;
export const MAX_QUERY_TERMS = 12;

export function queryInputError(raw: string): string | null {
  if (raw.length > MAX_QUERY_LENGTH) return "Use at most 512 characters.";
  if (tokenize(raw, true).tokens.length > MAX_QUERY_TERMS) {
    return "Use at most 12 query tokens (including operators).";
  }
  return null;
}

interface FilterableTweet {
  authorId: string;
  createdAt: number;
  mediaType: string;
  likeCount: number;
  lang?: string;
  text: string;
}

/** Token inventory for one tweet: unigrams, aspects, and adjacent bigrams. */
export interface TweetAnalysis {
  withStops: Term[];
  indexed: Term[];
  counts: Map<Term, number>;
  present: Set<Term>;
}

export function analyzeTweet(text: string): TweetAnalysis {
  // One tokenizer pass: the indexed stream is exactly the keepStopwords stream
  // minus stopwords (same emission order, same pushToken predicate), so a
  // second full NFKC+scan per candidate is redundant work. isStopword reads the
  // same module-level Set the tokenizer filters with.
  const full = tokenize(text, true);
  const indexedTokens = full.tokens.filter((t) => !isStopword(t));
  const withStops = full;
  const indexed = {
    tokens: indexedTokens as Term[],
    counts: new Map<Term, number>(),
    hasLink: full.hasLink,
  };
  for (const t of indexedTokens) indexed.counts.set(t, (indexed.counts.get(t) ?? 0) + 1);
  const aspects = mapAspects(indexed.tokens, text);
  const bigrams = adjacentBigrams(indexed.tokens);
  const present = new Set<Term>(indexed.tokens);
  for (const aspect of aspects) present.add(aspect);
  for (const bigram of bigrams) present.add(bigram);
  return {
    withStops: withStops.tokens,
    indexed: indexed.tokens,
    counts: indexed.counts,
    present,
  };
}

/** Every retrieval path uses the same hard predicates before counting survivors. */
export function matchesConstraints(
  tweet: FilterableTweet,
  xq: XQuery,
  analysis: TweetAnalysis = analyzeTweet(tweet.text),
): boolean {
  const f = xq.filters;
  if (f.authorId !== null && tweet.authorId !== f.authorId) return false;
  if (f.since !== null && tweet.createdAt < f.since) return false;
  if (f.until !== null && tweet.createdAt >= f.until) return false;
  if (f.media !== null && tweet.mediaType !== f.media) return false;
  if (f.minLikes !== null && tweet.likeCount < f.minLikes) return false;
  if (f.lang !== null && tweet.lang !== f.lang) return false;
  const tokens = analysis.withStops;
  // Loops, not `.some`/nested `.every` closures: this runs per candidate
  // (≤200/query), so the callbacks were the hottest closures in the path.
  for (const term of xq.exclude) {
    if (tokens.includes(term)) return false;
  }
  if (xq.union) {
    // Explicit OR: one branch must match. Bare branches (should) are terms;
    // quoted branches (phrases) are adjacency groups — `"apple pie" OR tree`
    // must not accept a post that only says "apple".
    let matched = false;
    for (const term of xq.should) {
      if (tokens.includes(term)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const phrase of xq.phrases) {
        if (coversPhrase(tokens, phrase)) {
          matched = true;
          break;
        }
      }
    }
    return matched;
  }
  for (const phrase of xq.phrases) {
    if (!coversPhrase(tokens, phrase)) return false;
  }
  return true;
}

/** Remaining AND gates, checked against the tweet rather than a truncated posting list. */
export function matchesGates(analysis: TweetAnalysis, gateTerms: Term[]): boolean {
  for (const term of gateTerms) {
    if (!analysis.present.has(term)) return false;
  }
  return true;
}

/** One phrase matched with token adjacency. */
function coversPhrase(tokens: Term[], phrase: Term[]): boolean {
  for (let start = 0; start + phrase.length <= tokens.length; start++) {
    let hit = true;
    for (let offset = 0; offset < phrase.length; offset++) {
      if (tokens[start + offset] !== phrase[offset]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

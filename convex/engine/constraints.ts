import { tokenize } from "./tokenize";
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

/** Every retrieval path uses the same hard predicates before counting survivors. */
export function matchesConstraints(tweet: FilterableTweet, xq: XQuery): boolean {
  const f = xq.filters;
  if (f.authorId !== null && tweet.authorId !== f.authorId) return false;
  if (f.since !== null && tweet.createdAt < f.since) return false;
  if (f.until !== null && tweet.createdAt >= f.until) return false;
  if (f.media !== null && tweet.mediaType !== f.media) return false;
  if (f.minLikes !== null && tweet.likeCount < f.minLikes) return false;
  if (f.lang !== null && tweet.lang !== f.lang) return false;
  const tokens = tokenize(tweet.text, true).tokens;
  if (xq.exclude.some((term) => tokens.includes(term))) return false;
  return xq.phrases.every((phrase) =>
    tokens.some((_, start) => phrase.every((term, offset) => tokens[start + offset] === term)),
  );
}

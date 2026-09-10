import { tokenize } from "./tokenize";
import { dual } from "effect/Function";
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

/** Every retrieval path uses the same hard predicates before counting survivors. */
export const matchesConstraints: {
  (tweet: FilterableTweet, xq: XQuery): boolean;
  (xq: XQuery): (tweet: FilterableTweet) => boolean;
} = dual(2, (tweet: FilterableTweet, xq: XQuery): boolean => {
  const f = xq.filters;
  if (f.authorId !== null && tweet.authorId !== f.authorId) return false;
  if (f.since !== null && tweet.createdAt < f.since) return false;
  if (f.until !== null && tweet.createdAt >= f.until) return false;
  if (f.media !== null && tweet.mediaType !== f.media) return false;
  if (f.minLikes !== null && tweet.likeCount < f.minLikes) return false;
  if (f.lang !== null && tweet.lang !== f.lang) return false;
  const tokens = tokenize(tweet.text, true).tokens;
  // Loops, not `.some`/nested `.every` closures: this runs per candidate
  // (≤200/query), so the callbacks were the hottest closures in the path.
  for (const term of xq.exclude) {
    if (tokens.includes(term)) return false;
  }
  for (const phrase of xq.phrases) {
    if (!coversPhrase(tokens, phrase)) return false;
  }
  return true;
});

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

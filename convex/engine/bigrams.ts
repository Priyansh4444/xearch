// Adjacent token pairs as extra posting terms (DESIGN §9 "positions").
// Encoding is shared with indexer/src/pipeline.rs::adjacent_bigrams.
// The tokenizer never emits U+0002, so these cannot collide with unigrams.

import type { Term } from "../contracts/ids";

export const BIGRAM_MARKER = "\u0002";

export function isBigramTerm(term: string): boolean {
  return term.charCodeAt(0) === 2;
}

/** Consecutive content-token pairs from an already-tokenized stream. */
export function adjacentBigrams(tokens: Term[]): Term[] {
  const out: Term[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (a.charCodeAt(0) === 2 || b.charCodeAt(0) === 2) continue;
    if (a.startsWith("~") || b.startsWith("~")) continue;
    out.push(`${BIGRAM_MARKER}${a}${BIGRAM_MARKER}${b}` as Term);
  }
  return out;
}

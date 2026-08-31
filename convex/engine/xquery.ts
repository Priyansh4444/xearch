// XQuery: the canonical IR. Owner of contract #3 (ARCHITECTURE.md).
// Everything downstream of parsing consumes ONLY this shape; nothing downstream
// ever sees the raw query string. Mirrored by docs/PARSER.md §1 (JSON Schema) and
// the Tier C output grammar. Bump `v` on any breaking change.

export const XQUERY_VERSION = 1 as const;

export type Intent =
  | "topic"
  | "person"
  | "person_topic"
  | "media"
  | "question"
  | "compare"
  | "event";

export type MediaFilter = "image" | "video" | "gif";

export interface XQueryFilters {
  authorId: string | null; // resolved id — NEVER a handle or display name
  since: number | null; // epoch ms, absolute (parser resolves relative forms)
  until: number | null;
  media: MediaFilter | null;
  minLikes: number | null;
  lang: string | null;
}

export interface XQuery {
  v: typeof XQUERY_VERSION;
  intent: Intent;
  /** AND terms, tokenizer-normalized. Gate retrieval. */
  must: string[];
  /** Soft terms: rerank boosts + L2 union. Never gate. */
  should: string[];
  /** Exact-adjacency groups (positions verify post-v1; until then treated as must). */
  phrases: string[][];
  exclude: string[];
  /** Canonical aspect tokens (~price, ...) — closed vocabulary from shared/lexicons. */
  aspects: string[];
  filters: XQueryFilters;
  sort: "top" | "latest";
  // NOTE deliberately absent: presentation mode (list|answer). It rides in the
  // request envelope, chosen by the user — never inferred (DESIGN §4.1).
}

export const emptyFilters = (): XQueryFilters => ({
  authorId: null,
  since: null,
  until: null,
  media: null,
  minLikes: null,
  lang: null,
});

export const emptyXQuery = (): XQuery => ({
  v: XQUERY_VERSION,
  intent: "topic",
  must: [],
  should: [],
  phrases: [],
  exclude: [],
  aspects: [],
  filters: emptyFilters(),
  sort: "top",
});

/**
 * Canonical JSON: fixed key order, sorted term arrays, null (never undefined).
 * INVARIANT: two XQuery values meaning the same thing serialize identically —
 * this string is the identity used by queryCache, answers, and feedback.
 */
export function canonicalJson(xq: XQuery): string {
  const sorted = (xs: string[]) => [...xs].sort();
  const phrases = xq.phrases
    .map((p) => [...p])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  return JSON.stringify({
    v: xq.v,
    intent: xq.intent,
    must: sorted(xq.must),
    should: sorted(xq.should),
    phrases,
    exclude: sorted(xq.exclude),
    aspects: sorted(xq.aspects),
    filters: {
      authorId: xq.filters.authorId,
      since: xq.filters.since,
      until: xq.filters.until,
      media: xq.filters.media,
      minLikes: xq.filters.minLikes,
      lang: xq.filters.lang,
    },
    sort: xq.sort,
  });
}

/**
 * queryKey: FNV-1a 64-bit over canonical JSON, hex. Not cryptographic — it's a
 * cache/aggregation key at hackathon scale; trivially portable to Rust.
 */
export function queryKey(xq: XQuery): string {
  const s = canonicalJson(xq);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/** Parse + validate an untrusted JSON string (Tier C output, cache rows). */
export function parseXQueryJson(json: string): XQuery | null {
  // TODO: field-by-field validation against the closed enums (PARSER §1).
  // Constrained decoding makes malformed Tier C output unrepresentable, but cache
  // rows written by older versions still cross this boundary — validate anyway.
  throw new Error("not implemented: parseXQueryJson");
}

/**
 * Merge a Tier C refinement into an A+B parse. Tier C may FILL empty slots and
 * ADD should/aspects; it may never contradict operator-set slots (PARSER §2).
 */
export function mergeRefinement(base: XQuery, refined: XQuery): XQuery {
  // TODO: slot-wise merge honoring the may-not-override rule; count overridden
  // attempts into the trace for the eval harness.
  throw new Error("not implemented: mergeRefinement");
}

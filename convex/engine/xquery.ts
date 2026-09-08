// XQuery: the canonical IR. Owner of contract #3 (ARCHITECTURE.md).
// Everything downstream of parsing consumes ONLY this shape; nothing downstream
// ever sees the raw query string. Mirrored by docs/PARSER.md §1 (JSON Schema) and
// the Tier C output grammar. Bump `v` on any breaking change.

import { Option } from "effect";
import * as Schema from "effect/Schema";
import type { VisualMediaType } from "../contracts/media";

export const XQUERY_VERSION = 1 as const;

export type Intent =
  | "topic"
  | "person"
  | "person_topic"
  | "media"
  | "question"
  | "compare"
  | "event";

export type MediaFilter = VisualMediaType;

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
  /** Exact token-adjacency groups, including stopwords; verified on candidate text. */
  phrases: string[][];
  exclude: string[];
  /** Canonical aspect tokens (~price, ...) — closed vocabulary from shared/lexicons. */
  aspects: string[];
  filters: XQueryFilters;
  sort: "top" | "latest";
  // NOTE deliberately absent: presentation mode (list|answer). It rides in the
  // request envelope, chosen by the user — never inferred (DESIGN §4.1).
}

const XQuerySchema = Schema.Struct({
  v: Schema.Literal(XQUERY_VERSION),
  intent: Schema.Literals(["topic", "person", "person_topic", "media", "question", "compare", "event"]),
  must: Schema.Array(Schema.String),
  should: Schema.Array(Schema.String),
  phrases: Schema.Array(Schema.Array(Schema.String)),
  exclude: Schema.Array(Schema.String),
  aspects: Schema.Array(Schema.String),
  filters: Schema.Struct({
    authorId: Schema.NullOr(Schema.String),
    since: Schema.NullOr(Schema.Number),
    until: Schema.NullOr(Schema.Number),
    media: Schema.NullOr(Schema.Literals(["image", "video", "gif"])),
    minLikes: Schema.NullOr(Schema.Number),
    lang: Schema.NullOr(Schema.String),
  }),
  sort: Schema.Literals(["top", "latest"]),
});

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
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = Schema.decodeUnknownOption(XQuerySchema)(value);
  if (Option.isNone(parsed)) return null;
  return {
    ...parsed.value,
    must: [...parsed.value.must],
    should: [...parsed.value.should],
    phrases: parsed.value.phrases.map((phrase) => [...phrase]),
    exclude: [...parsed.value.exclude],
    aspects: [...parsed.value.aspects],
    filters: { ...parsed.value.filters },
  };
}

/**
 * Merge a Tier C refinement into an A+B parse. Tier C may FILL empty slots and
 * ADD should/aspects; it may never contradict operator-set slots (PARSER §2).
 */
export function mergeRefinement(base: XQuery, refined: XQuery): XQuery {
  const filters = {
    authorId: base.filters.authorId ?? refined.filters.authorId,
    since: base.filters.since ?? refined.filters.since,
    until: base.filters.until ?? refined.filters.until,
    media: base.filters.media ?? refined.filters.media,
    minLikes: base.filters.minLikes ?? refined.filters.minLikes,
    lang: base.filters.lang ?? refined.filters.lang,
  };
  const unique = (values: string[]): string[] => [...new Set(values)];
  const phrases = [...base.phrases, ...refined.phrases]
    .filter((phrase, index, all) =>
      all.findIndex((candidate) => candidate.join("\u0000") === phrase.join("\u0000")) === index,
    )
    .map((phrase) => [...phrase]);

  return {
    ...base,
    intent: base.intent === "topic" ? refined.intent : base.intent,
    must: unique([...base.must, ...refined.must]),
    should: unique([...base.should, ...refined.should]),
    phrases,
    exclude: unique([...base.exclude, ...refined.exclude]),
    aspects: unique([...base.aspects, ...refined.aspects]),
    filters,
    sort: base.sort,
  };
}

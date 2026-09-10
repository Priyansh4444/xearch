// XQuery: the canonical IR. Owner of contract #3 (ARCHITECTURE.md).
// Everything downstream of parsing consumes ONLY this shape; nothing downstream
// ever sees the raw query string. Mirrored by docs/PARSER.md §1 (JSON Schema) and
// the Tier C output grammar. Bump `v` on any breaking change.

import { Option } from "effect";
import * as Schema from "effect/Schema";
import { VISUAL_MEDIA_TYPES, type VisualMediaType } from "../contracts/media";
import type { AuthorId, QueryKey, Term } from "../contracts/ids";
import { MAX_QUERY_TERMS } from "./constraints";
import aspectsFile from "../../shared/lexicons/aspects.json";

export const XQUERY_VERSION = 1 as const;

export const Intent = {
  Topic: "topic",
  Person: "person",
  PersonTopic: "person_topic",
  Media: "media",
  Question: "question",
  Compare: "compare",
  Event: "event",
} as const;
export type Intent = (typeof Intent)[keyof typeof Intent];

export const SortOrder = {
  Top: "top",
  Latest: "latest",
} as const;
export type SortOrder = (typeof SortOrder)[keyof typeof SortOrder];

export type MediaFilter = VisualMediaType;

export interface XQueryFilters {
  authorId: AuthorId | null; // resolved id — NEVER a handle or display name
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
  must: Term[];
  /** Soft terms: rerank boosts + L2 union. Never gate. */
  should: Term[];
  /** Exact token-adjacency groups, including stopwords; verified on candidate text. */
  phrases: Term[][];
  exclude: Term[];
  /** Canonical aspect tokens (~price, ...) — closed vocabulary from shared/lexicons. */
  aspects: Term[];
  filters: XQueryFilters;
  sort: SortOrder;
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
  intent: Intent.Topic,
  must: [],
  should: [],
  phrases: [],
  exclude: [],
  aspects: [],
  filters: emptyFilters(),
  sort: SortOrder.Top,
});

/**
 * Canonical JSON: fixed key order, sorted term arrays, null (never undefined).
 * INVARIANT: two XQuery values meaning the same thing serialize identically —
 * this string is the identity used by queryCache, answers, and feedback.
 */
export function canonicalJson(xq: XQuery): string {
  const sorted = (xs: Term[]) => [...xs].sort();
  // Full element-wise comparison: first-token-only ordering lets shared-prefix
  // phrase lists (e.g. [["a","x"],["a","y"]] vs reversed) hash differently and
  // split queryCache answers and feedback totals.
  const phrases = xq.phrases
    .map((p) => [...p])
    .sort((a, b) => {
      const shared = Math.min(a.length, b.length);
      for (let i = 0; i < shared; i++) {
        const d = (a[i] ?? "").localeCompare(b[i] ?? "");
        if (d !== 0) return d;
      }
      return a.length - b.length;
    });
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
export function queryKey(xq: XQuery): QueryKey {
  const s = canonicalJson(xq);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0") as QueryKey;
}

/** queryCache identity (PARSER §4): one row per normalized raw phrasing. */
export function normalizeRaw(raw: string): string {
  return raw.trim().toLowerCase();
}

const MAX_TERM_LENGTH = 64;
const MAX_AUTHOR_ID_LENGTH = 32;
const MAX_PHRASES = 4;
const MAX_PHRASE_TOKENS = 12;
const MAX_MIN_LIKES = 1_000_000_000;
const EPOCH_MS_MIN = Date.UTC(2000, 0, 1);
const EPOCH_MS_MAX = Date.UTC(2100, 0, 1);

/** Filter timestamp contract: integer epoch ms between 2000 and 2100. */
export const EpochMsSchema = Schema.Int.check(
  Schema.isBetween({ minimum: EPOCH_MS_MIN, maximum: EPOCH_MS_MAX }),
);

/** Schema-backed guard used to sanitize optional model output before decoding the IR. */
export const isEpochMs = Schema.is(EpochMsSchema);

// The canonical XQuery wire codec (TODO P1: "canonical XQuery as Effect Schema
// codec"). Closed enums come from the same const objects / lexicon file the rest
// of the engine uses, so the codec cannot drift from the types it guards.
// Branding note: decoded strings are asserted into the type-only Term/AuthorId
// brands once, at the rebuild below — the documented boundary rule (contracts/ids).
const TermSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_TERM_LENGTH),
  Schema.isPattern(/^\S+$/), // tokenizer-normalized: no whitespace…
  Schema.isLowercased(), // …and already lowercased
);

const XQueryWireSchema = Schema.Struct({
  v: Schema.Literal(XQUERY_VERSION),
  intent: Schema.Literals(Object.values(Intent)),
  must: Schema.Array(TermSchema).check(Schema.isMaxLength(MAX_QUERY_TERMS)),
  should: Schema.Array(TermSchema).check(Schema.isMaxLength(MAX_QUERY_TERMS)),
  phrases: Schema.Array(
    Schema.Array(TermSchema).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PHRASE_TOKENS)),
  ).check(Schema.isMaxLength(MAX_PHRASES)),
  exclude: Schema.Array(TermSchema).check(Schema.isMaxLength(MAX_QUERY_TERMS)),
  aspects: Schema.Array(Schema.Literals(Object.keys(aspectsFile.aspects))),
  filters: Schema.Struct({
    authorId: Schema.NullOr(TermSchema.check(Schema.isMaxLength(MAX_AUTHOR_ID_LENGTH))),
    since: Schema.NullOr(EpochMsSchema),
    until: Schema.NullOr(EpochMsSchema),
    media: Schema.NullOr(Schema.Literals([...VISUAL_MEDIA_TYPES])),
    minLikes: Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_MIN_LIKES })),
    ),
    lang: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z]{2}$/))),
  }),
  sort: Schema.Literals(Object.values(SortOrder)),
});

const decodeXQueryWire = Schema.decodeUnknownOption(XQueryWireSchema);

/**
 * Parse + validate an untrusted JSON string (Tier C output, cache rows) against
 * the closed-enum wire codec above (PARSER §1). Constrained decoding makes
 * malformed Tier C output unrepresentable, but cache rows written by older
 * versions still cross this boundary — validate anyway. Returns a rebuilt,
 * deduplicated XQuery (never the parsed object itself) or null; it never throws.
 */
export function parseXQueryJson(json: string): XQuery | null {
  let parsed: Option.Option<typeof XQueryWireSchema.Type>;
  try {
    parsed = decodeXQueryWire(JSON.parse(json));
  } catch {
    return null;
  }
  if (Option.isNone(parsed)) return null;
  const wire = parsed.value;
  const terms = (xs: readonly string[]) => [...new Set(xs)] as Term[];
  return {
    v: XQUERY_VERSION,
    intent: wire.intent,
    must: terms(wire.must),
    should: terms(wire.should),
    phrases: wire.phrases.map((p) => [...p] as Term[]),
    exclude: terms(wire.exclude),
    aspects: terms(wire.aspects),
    filters: {
      authorId: wire.filters.authorId as AuthorId | null,
      since: wire.filters.since,
      until: wire.filters.until,
      media: wire.filters.media,
      minLikes: wire.filters.minLikes,
      lang: wire.filters.lang,
    },
    sort: wire.sort,
  };
}

export interface RefinementMerge {
  xq: XQuery;
  /** Slot names the refinement filled or extended — the "refined: …" chips. */
  filled: string[];
  /** Refinement attempts rejected by the may-not-override rule (eval harness). */
  overridden: string[];
}

/**
 * Merge a Tier C refinement into an A+B parse, slot-wise (PARSER §2): Tier C may
 * FILL empty slots and ADD should/aspects; it may never contradict a slot the
 * base parse set. Extra refined `must` terms demote to `should` — a refinement
 * must never tighten the gate set beyond what A+B established. `sort` is owned
 * by the user (operator or tab) and never merges. Pure; inputs are not mutated.
 */
export function mergeRefinement(base: XQuery, refined: XQuery): RefinementMerge {
  const filled: string[] = [];
  const overridden: string[] = [];
  const xq: XQuery = {
    v: base.v,
    intent: base.intent,
    must: [...base.must],
    should: [...base.should],
    phrases: base.phrases.map((p) => [...p]),
    exclude: [...base.exclude],
    aspects: [...base.aspects],
    filters: { ...base.filters },
    sort: base.sort,
  };

  // intent: Topic is the unset default; anything else came from B and stands.
  if (refined.intent !== base.intent) {
    if (base.intent === Intent.Topic) {
      xq.intent = refined.intent;
      filled.push("intent");
    } else if (refined.intent !== Intent.Topic) {
      overridden.push("intent");
    }
  }

  // must gates retrieval: fill only when empty; extra refined terms → should.
  const demoted: Term[] = [];
  if (base.must.length === 0 && refined.must.length > 0) {
    xq.must = [...refined.must];
    filled.push("must");
  } else {
    for (const term of refined.must) {
      if (!base.must.includes(term)) demoted.push(term);
    }
  }

  // should/aspects are additive by contract.
  const shouldAdds: Term[] = [];
  for (const term of [...refined.should, ...demoted]) {
    if (
      !xq.should.includes(term) &&
      !xq.must.includes(term) &&
      !xq.exclude.includes(term) &&
      !shouldAdds.includes(term) &&
      xq.should.length + shouldAdds.length < MAX_QUERY_TERMS
    ) {
      shouldAdds.push(term);
    }
  }
  if (shouldAdds.length > 0) {
    xq.should = [...xq.should, ...shouldAdds];
    filled.push("should");
  }
  const aspectAdds = refined.aspects.filter((a) => !xq.aspects.includes(a));
  if (aspectAdds.length > 0) {
    xq.aspects = [...xq.aspects, ...aspectAdds];
    filled.push("aspects");
  }

  // phrases/exclude: fill-if-empty (a phrase or negation the user typed stands).
  if (refined.phrases.length > 0) {
    if (base.phrases.length === 0) {
      xq.phrases = refined.phrases.map((p) => [...p]);
      filled.push("phrases");
    } else if (JSON.stringify(refined.phrases) !== JSON.stringify(base.phrases)) {
      overridden.push("phrases");
    }
  }
  if (refined.exclude.length > 0) {
    if (base.exclude.length === 0) {
      xq.exclude = [...refined.exclude];
      filled.push("exclude");
    } else if (JSON.stringify(refined.exclude) !== JSON.stringify(base.exclude)) {
      overridden.push("exclude");
    }
  }

  // filters: null means unset; a base value always wins.
  const fillFilter = <K extends keyof XQueryFilters>(slot: K) => {
    const refinedValue = refined.filters[slot];
    if (refinedValue === null) return;
    if (base.filters[slot] === null) {
      xq.filters[slot] = refinedValue;
      filled.push(`filters.${slot}`);
    } else if (base.filters[slot] !== refinedValue) {
      overridden.push(`filters.${slot}`);
    }
  };
  for (const slot of ["authorId", "since", "until", "media", "minLikes", "lang"] as const) {
    fillFilter(slot);
  }

  if (refined.sort !== base.sort) overridden.push("sort");

  return { xq, filled, overridden };
}

// Loose Parser Tiers A + B (DESIGN §4.2–4.3, contracts in docs/PARSER.md §2).
// Pure domain logic: no ctx, no I/O. Tier B's lookups (entity linking, df probes)
// are injected as async callbacks so search.ts can back them with ctx.db and tests
// can back them with fixtures (per boundary-discipline).

import { tokenize } from "./tokenize";
import {
  emptyXQuery,
  type Intent,
  type MediaFilter,
  type XQuery,
} from "./xquery";
import aspectsFile from "../../shared/lexicons/aspects.json";

export interface ParseTrace {
  tier: "A" | "B";
  consumed: Record<string, string>; // rawFragment -> slot it filled
  leftover: string[]; // tokens neither tier could classify (Tier C trigger input)
  entityAmbiguous: boolean; // true when linking was withheld by the dominance rule
}

export interface TierBDeps {
  /**
   * Resolve a candidate name/handle n-gram to an author. MUST apply the dominance
   * rule (top authority >= 10x runner-up AND token not a high-df common word) and
   * return null otherwise — under-linking beats wrong-linking (RISKS P1).
   */
  resolveEntity(ngram: string[]): Promise<{ authorId: string } | null>;
  /** df probe for spelling repair; null when term unseen. */
  dfOf(term: string): Promise<number | null>;
  now(): number;
}

/** Tier A: deterministic operator grammar. Total function — never throws. */
export function tierA(raw: string): { xq: XQuery; trace: ParseTrace } {
  const xq = emptyXQuery();
  const trace: ParseTrace = {
    tier: "A",
    consumed: {},
    leftover: [],
    entityAmbiguous: false,
  };
  let rest = raw;

  // "quoted phrases"
  rest = rest.replace(/"([^"]+)"/g, (_m, phrase: string) => {
    const toks = tokenize(phrase).tokens;
    if (toks.length > 0) {
      xq.phrases.push(toks);
      trace.consumed[`"${phrase}"`] = "phrases";
    }
    return " ";
  });

  // operator:value pairs
  const OPS: Record<string, (val: string) => boolean> = {
    from: (val) => {
      // Handle recorded verbatim; resolution to authorId happens in Tier B deps
      // (from: is still an operator — it must never soft-fail into a term).
      pendingFromHandle = val.replace(/^@/, "").toLowerCase();
      return true;
    },
    since: (val) => setTime("since", val),
    until: (val) => setTime("until", val),
    has: (val) =>
      ["image", "video", "gif"].includes(val)
        ? ((xq.filters.media = val as MediaFilter), true)
        : false,
    min_likes: (val) =>
      /^\d+$/.test(val) ? ((xq.filters.minLikes = Number(val)), true) : false,
    lang: (val) =>
      /^[a-z]{2}$/.test(val) ? ((xq.filters.lang = val), true) : false,
    sort: (val) =>
      val === "latest" || val === "top" ? ((xq.sort = val), true) : false,
  };
  let pendingFromHandle: string | null = null;
  const setTime = (_slot: "since" | "until", _val: string): boolean => {
    // absolute YYYY-MM-DD or relative Nd/Nh — resolved to epoch ms so the IR never
    // carries relative forms (PARSER §1). Relative forms need `now`, which Tier B's
    // deps carry; Tier A records the raw value and Tier B finalizes.
    // TODO(implement). Until then: return false => operator stays literal text.
    // tierA is a TOTAL function — unimplemented paths degrade, never throw.
    return false;
  };

  rest = rest.replace(
    /(^|\s)([a-z_]+):(\S+)/gi,
    (m, pre: string, op: string, val: string) => {
      const handler = OPS[op.toLowerCase()];
      if (handler && handler(val)) {
        trace.consumed[`${op}:${val}`] = op;
        return pre;
      }
      return m; // unknown operator stays literal text (correctness invariant)
    },
  );

  // -negations
  rest = rest.replace(/(^|\s)-(\p{L}[\p{L}\p{N}_]*)/gu, (_m, pre: string, w: string) => {
    xq.exclude.push(...tokenize(w).tokens);
    trace.consumed[`-${w}`] = "exclude";
    return pre;
  });

  xq.must = tokenize(rest).tokens;
  (xq as XQueryWithPending).pendingFromHandle = pendingFromHandle;
  return { xq, trace };
}

/** Tier A leaves the unresolved from:-handle for Tier B to link. Internal only. */
type XQueryWithPending = XQuery & { pendingFromHandle?: string | null };

/**
 * Tier B: lexicon annotator. Consumes Tier A's leftovers; only refines.
 * Order matters and is part of the contract:
 *   1. resolve pending from:-handle -> authorId (hard filter; error surface if unknown)
 *   2. glue-phrase stripping + intent detection (question/compare/media/person)
 *   3. entity linking over remaining n-grams (dominance rule inside deps)
 *   4. temporal lexicon ("last week", "in 2023") — preposition-anchored (RISKS P4)
 *   5. aspect mapping (strong patterns always; weak only with content co-occurrence, ASPECTS G5)
 *   6. spelling repair for df≈0 tokens (edit-distance-1 probes via deps.dfOf)
 */
export async function tierB(
  parsed: { xq: XQuery; trace: ParseTrace },
  deps: TierBDeps,
): Promise<{ xq: XQuery; trace: ParseTrace }> {
  // TODO(implement): steps 1–6 above. Each step moves tokens out of xq.must into
  // slots and records trace.consumed; anything left unexplained lands in
  // trace.leftover (Tier C's trigger input, PARSER §4).
  throw new Error("not implemented: tierB");
}

/**
 * Aspect mapping over a token stream — shared by Tier B (query side) and reused
 * conceptually by the Rust indexer (doc side). Exported for golden tests.
 * Strong patterns match as phrases; weak single words require >=1 co-occurring
 * non-aspect content token (ASPECTS.md G5). "$"+digits in the ORIGINAL text is a
 * ~price signal (tokenizer already reduced it to a bare number — hence rawText).
 */
export function mapAspects(tokens: string[], rawText: string): string[] {
  const found = new Set<string>();
  const joined = " " + tokens.join(" ") + " ";
  const entries = Object.entries(aspectsFile.aspects) as Array<
    [string, { strong: string[]; weak: string[] }]
  >;
  const contentTokens = tokens.filter((t) => !t.startsWith("~"));
  for (const [aspect, { strong, weak }] of entries) {
    if (strong.some((p) => joined.includes(" " + p + " "))) {
      found.add(aspect);
      continue;
    }
    const weakHits = weak.filter((w) => joined.includes(" " + w + " "));
    if (weakHits.length > 0 && contentTokens.length > weakHits.length) {
      found.add(aspect);
    }
  }
  if (/\$\d/.test(rawText)) found.add("~price");
  return [...found].sort();
}

/** Interrogative-shape detector (question intent, PARSER golden rows). */
export function detectQuestionIntent(raw: string, tokens: string[]): Intent | null {
  const first = tokens[0];
  const interrogatives = ["what", "who", "why", "how", "when", "where", "which"];
  if (first !== undefined && interrogatives.includes(first)) return "question";
  if (raw.trimEnd().endsWith("?")) return "question";
  return null;
}

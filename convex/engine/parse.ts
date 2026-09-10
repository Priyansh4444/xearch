// Loose Parser Tiers A + B (DESIGN §4.2–4.3, contracts in docs/PARSER.md §2).
// Pure domain logic: no ctx, no I/O. Tier B's lookups (entity linking, df probes)
// are injected as async callbacks so search.ts can back them with ctx.db and tests
// can back them with fixtures (per boundary-discipline).

import { tokenize } from "./tokenize";
import type { AuthorId, Term } from "../contracts/ids";
import { emptyXQuery, Intent, SortOrder, type MediaFilter, type XQuery } from "./xquery";
import { VISUAL_MEDIA_TYPES } from "../contracts/media";
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
  resolveEntity(ngram: string[]): Promise<{ authorId: AuthorId } | null>;
  /**
   * Resolve an explicit from:-operator handle. Unlike resolveEntity this is a
   * hard filter with no dominance rule: the user typed the handle; exact
   * authors.by_handle match or null.
   */
  resolveHandle(handle: string): Promise<{ authorId: AuthorId } | null>;
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
    const toks = tokenize(phrase, true).tokens;
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
    has: (val) => {
      const media = VISUAL_MEDIA_TYPES.find((type) => type === val);
      if (media === undefined) return false;
      xq.filters.media = media;
      return true;
    },
    min_likes: (val) => (/^\d+$/.test(val) ? ((xq.filters.minLikes = Number(val)), true) : false),
    lang: (val) => (/^[a-z]{2}$/.test(val) ? ((xq.filters.lang = val), true) : false),
    sort: (val) =>
      val === SortOrder.Latest || val === SortOrder.Top ? ((xq.sort = val), true) : false,
  };
  let pendingFromHandle: string | null = null;
  const pendingTime: { since: string | null; until: string | null } = {
    since: null,
    until: null,
  };
  const setTime = (slot: "since" | "until", val: string): boolean => {
    // absolute YYYY-MM-DD or relative Nd/Nh/Nw — resolved to epoch ms so the IR
    // never carries relative forms (PARSER §1). Relative forms need `now`, which
    // Tier B's deps carry; Tier A records the raw value and Tier B finalizes.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val) && !/^\d+[dhw]$/.test(val)) return false;
    pendingTime[slot] = val;
    return true;
  };

  rest = rest.replace(/(^|\s)([a-z_]+):(\S+)/gi, (m, pre: string, op: string, val: string) => {
    const handler = OPS[op.toLowerCase()];
    if (handler && handler(val)) {
      trace.consumed[`${op}:${val}`] = op.toLowerCase();
      return pre;
    }
    return m; // unknown operator stays literal text (correctness invariant)
  });

  // -negations
  rest = rest.replace(/(^|\s)-(\p{L}[\p{L}\p{N}_]*)/gu, (_m, pre: string, w: string) => {
    xq.exclude.push(...tokenize(w).tokens);
    trace.consumed[`-${w}`] = "exclude";
    return pre;
  });

  xq.must = tokenize(rest).tokens;
  const px = xq as XQueryWithPending;
  px.pendingFromHandle = pendingFromHandle;
  px.pendingSince = pendingTime.since;
  px.pendingUntil = pendingTime.until;
  px.rawRest = rest;
  return { xq, trace };
}

/** Tier A leaves unresolved operator values + the residual text for Tier B. Internal only. */
type XQueryWithPending = XQuery & {
  pendingFromHandle?: string | null;
  pendingSince?: string | null;
  pendingUntil?: string | null;
  /** rest of the raw string after operators/phrases/negations were consumed. */
  rawRest?: string;
};

/**
 * Text Tier A left after consuming operators, phrases and negations. The baseline
 * lane tokenizes it with stopwords kept so an all-stopword query stays searchable.
 */
export function residualText(xq: XQuery): string {
  return (xq as XQueryWithPending).rawRest ?? "";
}

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
  const px = parsed.xq as XQueryWithPending;
  const xq = parsed.xq;
  const trace = parsed.trace;
  trace.tier = "B";
  const rawRest = px.rawRest ?? "";
  const consume = (fragment: string, slot: string) => {
    trace.consumed[fragment] = slot;
  };

  // 1. from:-handle -> authorId. Hard filter: an unknown handle is surfaced in
  //    leftover (the caller decides how to error), never soft-failed into a term.
  if (px.pendingFromHandle != null) {
    const hit = await deps.resolveHandle(px.pendingFromHandle);
    if (hit !== null) {
      xq.filters.authorId = hit.authorId;
      consume(`from:${px.pendingFromHandle}`, "filters.authorId");
    } else {
      trace.leftover.push(`from:${px.pendingFromHandle}`);
    }
  }

  // 2a. Operator dates recorded by Tier A (absolute or relative), now resolvable.
  const now = deps.now();
  if (px.pendingSince != null) {
    const since = resolveDateValue(px.pendingSince, now);
    if (since === null) trace.leftover.push(`since:${px.pendingSince}`);
    else {
      xq.filters.since = since;
      consume(`since:${px.pendingSince}`, "filters.since");
    }
  }
  if (px.pendingUntil != null) {
    const until = resolveDateValue(px.pendingUntil, now);
    if (until === null) trace.leftover.push(`until:${px.pendingUntil}`);
    else {
      xq.filters.until = until;
      consume(`until:${px.pendingUntil}`, "filters.until");
    }
  }

  // 2b. NL negation needs the raw residue ("not" is a stopword and never reaches
  //     the token stream): "apple tweets not about the iphone" -> exclude iphone.
  for (const m of rawRest.matchAll(
    /(?:^|\s)not\s+(?:about\s+|having\s+)?(?:the\s+|a\s+|an\s+)?([\p{L}\p{N}_#@'-]+)/giu,
  )) {
    for (const tok of tokenize(m[1]!).tokens) {
      if (!xq.exclude.includes(tok)) xq.exclude.push(tok);
      xq.must = xq.must.filter((t) => t !== tok);
      consume(`not … ${m[1]!}`, "exclude");
    }
  }

  // 2c. Temporal lexicon — anchored patterns only (RISKS P4: a bare month name
  //     never binds as a date; "million man march" stays three literal terms).
  applyTemporalLexicon(xq, rawRest, now, consume);

  // 2d. Glue is removed before media detection so "show photos" recognizes
  // "photos" as the first meaningful token.
  const GLUE = new Set([
    "tweets",
    "tweet",
    "posts",
    "post",
    "thread",
    "threads",
    "show",
    "me",
    "find",
    "search",
    "about",
    "say",
    "says",
    "said",
    "vs",
    "versus",
    "what",
    "who",
    "why",
    "how",
    "when",
    "where",
    "which",
    "someone",
  ]);
  const tokensWithoutGlue = xq.must.filter((token) => !GLUE.has(token));
  // Aspect detection intentionally sees glue words such as "vs" before
  // retrieval removes them.
  const tokensForAspects = [...xq.must];

  // 2e. Media lexicon: a leading media noun is a filter, not a term.
  const MEDIA_NOUNS: Record<string, MediaFilter> = {
    pic: "image",
    pics: "image",
    photo: "image",
    photos: "image",
    screenshot: "image",
    screenshots: "image",
    image: "image",
    images: "image",
    video: "video",
    videos: "video",
    clip: "video",
    clips: "video",
    gif: "gif",
    gifs: "gif",
  };
  const leading = tokensWithoutGlue[0];
  if (leading !== undefined && MEDIA_NOUNS[leading] !== undefined) {
    if (xq.filters.media === null) xq.filters.media = MEDIA_NOUNS[leading]!;
    xq.intent = Intent.Media;
    xq.must = tokensWithoutGlue.slice(1);
    consume(leading, "filters.media");
  } else {
    xq.must = tokensWithoutGlue;
  }

  // 2f. Question intent: interrogative shape, trailing "?", or an attribute-of
  //     opener ("height of taj mahal" — the attribute survives as structure).
  const question = detectQuestionIntent(rawRest, xq.must);
  if (question !== null && xq.intent === Intent.Topic) xq.intent = question;
  if (
    xq.intent === Intent.Topic &&
    /^\s*(height|weight|size|specs?|price|cost|dimensions?)\s+of\s/i.test(rawRest)
  ) {
    xq.intent = Intent.Question;
  }

  // 2g. Compare: "vs"/"versus" is glue AND a compare signal.
  if (tokensForAspects.some((t) => t === "vs" || t === "versus")) {
    if (xq.intent === Intent.Topic) xq.intent = Intent.Compare;
  }

  // Aspect mapping (step 5) sees the pre-glue token stream: glue words like
  // "vs" are aspect signals ("~compare") even though they never gate retrieval.
  for (const t of tokensForAspects) if (GLUE.has(t)) consume(t, "glue");

  // 3. An author filter means BY that account, not ABOUT it. A question alone
  // is not authorship evidence: "height of theo" must keep Theo as its subject.
  // Resolve only the speaker in explicit speech attribution, or a bare
  // single-token topic query. Never substitute another author for unknown from:.
  // The dominance + common-word rules still live inside deps (RISKS P1).
  const speaker = rawRest.match(/^\s*what\s+(?:did|does|do)\s+(@?[\p{L}\p{N}_]+)\s+say\b/iu)?.[1];
  const speakerTokens = speaker === undefined ? [] : tokenize(speaker).tokens;
  const bareAccount = /^\s*[\p{L}\p{N}_]+\s*$/u.test(rawRest);
  const entityCandidates =
    speaker !== undefined
      ? xq.must
          .filter((token) => !token.startsWith("@") && speakerTokens.includes(token))
          .slice(0, 1)
      : xq.intent === Intent.Topic && xq.must.length === 1 && bareAccount
        ? xq.must
        : [];
  if (px.pendingFromHandle == null && xq.filters.authorId === null) {
    for (const token of entityCandidates) {
      const hit = await deps.resolveEntity([token]);
      if (hit !== null) {
        xq.filters.authorId = hit.authorId;
        // Mentions dual-emit @handle + handle; both identify the same speaker.
        xq.must = xq.must.filter((t) =>
          speaker === undefined ? t !== token : !speakerTokens.includes(t),
        );
        // A question stays a question; otherwise this is a person(+topic) query.
        if (xq.intent === Intent.Topic) {
          xq.intent = xq.must.length > 0 ? Intent.PersonTopic : Intent.Person;
        }
        consume(token, "filters.authorId");
        break;
      }
    }
  }

  // 5. Aspect mapping; weak trigger words move to should (they gate nothing but
  //    boost polarity at rerank — DESIGN §4.6).
  const aspects = mapAspects(tokensForAspects, rawRest);
  if (aspects.length > 0) {
    xq.aspects = aspects;
    const weakWords = new Set<string>();
    for (const aspect of aspects) {
      for (const w of weakWordsFor(aspect)) weakWords.add(w);
    }
    const stay: Term[] = [];
    for (const t of xq.must) {
      if (weakWords.has(t)) {
        xq.should.push(t);
        consume(t, "should (weak aspect trigger)");
      } else {
        stay.push(t);
      }
    }
    // G5 guard, query side: never let an aspect empty the whole must set — a
    // bare attribute word ("cheap") stays a literal term.
    if (stay.length > 0) {
      xq.must = stay;
    } else {
      xq.aspects = [];
      xq.should = xq.should.filter((t) => !weakWords.has(t));
    }
  }

  // 6. Spelling repair (edit-distance-1 df probes) is deliberately deferred:
  //    Tier B's read budget is ~3 point reads (PARSER §2) and repair costs ~15.
  //    Unmatched tokens surface via leftover/L5 instead.

  delete px.pendingFromHandle;
  delete px.pendingSince;
  delete px.pendingUntil;
  delete px.rawRest;
  return { xq, trace };
}

/** since:/until: operator values: absolute YYYY-MM-DD or relative Nd/Nh/Nw. */
function resolveDateValue(val: string, now: number): number | null {
  const abs = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (abs !== null) {
    const year = Number(abs[1]);
    const month = Number(abs[2]);
    const day = Number(abs[3]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
    return Date.UTC(year, month - 1, day);
  }
  const rel = val.match(/^(\d+)([dhw])$/);
  if (rel === null) return null;
  const n = Number(rel[1]);
  const unitMs = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2] as "h" | "d" | "w"];
  return now - n * unitMs;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const SEASONS: Record<string, [number, number]> = {
  // [start month index, end month index) in the northern-hemisphere sense.
  spring: [2, 5],
  summer: [5, 8],
  fall: [8, 11],
  autumn: [8, 11],
  winter: [11, 14], // wraps into the next year
};

/**
 * ~15 anchored patterns cover the long tail. Anchors ("last", "this", "in",
 * "since", "during") are required: bare month/season words stay literal terms.
 */
function applyTemporalLexicon(
  xq: XQuery,
  rawRest: string,
  now: number,
  consume: (fragment: string, slot: string) => void,
) {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const day = 86_400_000;
  const startOfDay = Date.UTC(year, d.getUTCMonth(), d.getUTCDate());
  const setWindow = (fragment: string, since: number | null, until: number | null) => {
    // Operators win: the lexicon only fills empty slots.
    if (since !== null && xq.filters.since === null) xq.filters.since = since;
    if (until !== null && xq.filters.until === null) xq.filters.until = until;
    consume(fragment, "filters.since/until");
    stripTokens(xq, fragment);
  };

  const text = rawRest.toLowerCase();
  let m: RegExpMatchArray | null;

  if (/(^|\s)today(\s|$|\?)/.test(text)) setWindow("today", startOfDay, null);
  if (/(^|\s)yesterday(\s|$|\?)/.test(text)) setWindow("yesterday", startOfDay - day, startOfDay);

  if ((m = text.match(/(^|\s)(last|this|past)\s+(week|month|year)/)) !== null) {
    const unit = m[3]!;
    const span = unit === "week" ? 7 * day : unit === "month" ? 30 * day : 365 * day;
    setWindow(`${m[2]} ${unit}`, now - span, null);
  }

  if ((m = text.match(/(^|\s)(last|this)\s+(spring|summer|fall|autumn|winter)/)) !== null) {
    const [startMonth, endMonth] = SEASONS[m[3]!]!;
    // Most recent such season that has already started; "last" backs up one year.
    let y = year;
    if (Date.UTC(y, startMonth, 1) > now) y -= 1;
    if (m[2] === "last") y -= 1;
    setWindow(`${m[2]} ${m[3]}`, Date.UTC(y, startMonth, 1), Date.UTC(y, endMonth, 1));
  }

  if ((m = text.match(/(^|\s)in\s+((?:19|20)\d{2})(\s|$|\?)/)) !== null) {
    const y = Number(m[2]);
    setWindow(`in ${m[2]}`, Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1));
  }

  if (
    (m = text.match(
      /(^|\s)(in|since|during|before|after)\s+(january|february|march|april|may|june|july|august|september|october|november|december)(\s+((?:19|20)\d{2}))?(\s|$|\?)/,
    )) !== null
  ) {
    const anchor = m[2]!;
    const month = MONTHS.indexOf(m[3]!);
    const y = m[5] !== undefined ? Number(m[5]) : Date.UTC(year, month, 1) > now ? year - 1 : year;
    const start = Date.UTC(y, month, 1);
    const end = Date.UTC(y, month + 1, 1);
    const frag = `${anchor} ${m[3]}${m[5] !== undefined ? ` ${m[5]}` : ""}`;
    if (anchor === "in" || anchor === "during") setWindow(frag, start, end);
    else if (anchor === "since" || anchor === "after") setWindow(frag, start, null);
    else setWindow(frag, null, start);
  }
}

/** Remove a consumed fragment's tokens from must. */
function stripTokens(xq: XQuery, fragment: string) {
  const toks = new Set(tokenize(fragment).tokens);
  xq.must = xq.must.filter((t) => !toks.has(t));
}

/**
 * Aspect mapping over a token stream — shared by Tier B (query side) and reused
 * conceptually by the Rust indexer (doc side). Exported for golden tests.
 * Strong patterns match as phrases; weak single words require >=1 co-occurring
 * non-aspect content token (ASPECTS.md G5). "$"+digits in the ORIGINAL text is a
 * ~price signal (tokenizer already reduced it to a bare number — hence rawText).
 */
export function mapAspects(tokens: Term[], rawText: string): Term[] {
  const found = new Set<Term>();
  const joined = " " + tokens.join(" ") + " ";
  for (const [aspect, patterns] of ASPECT_ENTRIES) {
    if (hasPaddedHit(joined, patterns.strong)) {
      found.add(aspect);
      continue;
    }
    if (hasPaddedHit(joined, patterns.weak) && hasContentToken(tokens, patterns.weak)) {
      found.add(aspect);
    }
  }
  if (DOLLAR_DIGIT_RE.test(rawText)) found.add(ASPECT_PRICE);
  return [...found].sort();
}

/** Lexicon rows parsed once at module load, not on every query. Patterns stay
 * raw strings; only the aspect keys enter the Term space. */
const ASPECT_PRICE = "~price" as Term;
const ASPECT_ENTRIES: Array<[Term, { strong: string[]; weak: string[] }]> = (
  Object.entries(aspectsFile.aspects) as Array<[string, { strong: string[]; weak: string[] }]>
).map(([aspect, patterns]) => [aspect as Term, patterns]);

/** Weak trigger words for one aspect (Tier B moves them to `should`). */
function weakWordsFor(aspect: Term): string[] {
  for (const [name, patterns] of ASPECT_ENTRIES) {
    if (name === aspect) return patterns.weak;
  }
  return [];
}

const DOLLAR_DIGIT_RE = /\$\d/;

/** Any pattern present as a whitespace-delimited phrase. Plain loops: the
 * `.some`/`.filter` closures this replaces were built per aspect, per query. */
function hasPaddedHit(joined: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (joined.includes(" " + p + " ")) return true;
  }
  return false;
}

/** A non-aspect content token co-occurs (G5 guard against bare triggers). */
function hasContentToken(tokens: Term[], weak: string[]): boolean {
  for (const t of tokens) {
    if (!t.startsWith("~") && !weak.includes(t)) return true;
  }
  return false;
}

/** Interrogative-shape detector (question intent, PARSER golden rows). */
export function detectQuestionIntent(raw: string, tokens: string[]): Intent | null {
  // Glue stripping removes interrogatives from `tokens`, so inspect the raw
  // opener first and use the token list only for direct helper callers.
  const first =
    raw
      .trimStart()
      .match(/^[\p{L}\p{N}_]+/u)?.[0]
      ?.toLowerCase() ?? tokens[0];
  const interrogatives = ["what", "who", "why", "how", "when", "where", "which"];
  if (first !== undefined && interrogatives.includes(first)) return Intent.Question;
  if (raw.trimEnd().endsWith("?")) return Intent.Question;
  return null;
}

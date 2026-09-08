// Ladder planner (DESIGN §5). Pure: XQuery -> ReadPlan. search.ts executes plans
// against ctx.db and feeds row counts back to `escalate` — the planner never reads.
// Why: ladder logic stays unit-testable, and "bounded reads" is enforced by the
// type: a PostingsRead without a `limit` does not compile.

import type { XQuery } from "./xquery";
import { tokenize } from "./tokenize";

export const PER_TERM_CAP = 500; // 12 query terms + 5 PRF terms, cached across levels
export const MIN_RESULTS = 10; // ladder escalation threshold (§5.2)
export const RERANK_CANDIDATES = 200;

export type LadderLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

/** One bounded index read against `postings`. Maps 1:1 onto a withIndex call. */
export interface PostingsRead {
  term: string;
  /** Which compound index serves this read — mirrors schema.ts index names. */
  index:
    | "by_term_score"
    | "by_term_time"
    | "by_term_author_time"
    | "by_term_media_score";
  /** Equality prefix beyond `term` (authorId or mediaType), when the index has one. */
  eq?: { authorId?: string | undefined; mediaType?: string | undefined } | undefined;
  /** createdAt range for time-ordered indexes; postFilter for score-ordered ones. */
  timeRange?: { since?: number | undefined; until?: number | undefined } | undefined;
  order: "desc";
  limit: number; // REQUIRED — the invariant, in a type
}

export interface ReadPlan {
  level: LadderLevel;
  /** AND-groups: rarest term first; executor intersects in this order. */
  gates: PostingsRead[];
  /** Union reads (L2+): fused by RRF, never gate. */
  unions: PostingsRead[];
  /** Terms whose postings must NOT contain a candidate (exclude). Bounded probe. */
  excludes: string[];
  /** Post-intersection predicates the executor applies in memory. */
  postFilters: {
    since?: number | undefined;
    until?: number | undefined;
    media?: string | undefined;
    minLikes?: number | undefined;
    lang?: string | undefined;
  };
}

/**
 * L0: exact plan. Chooses per-term index by filter shape:
 * author filter -> by_term_author_time; media -> by_term_media_score;
 * sort latest OR date-window -> by_term_time; else by_term_score.
 * Terms are ordered rarest-first by caller-provided dfs (planner stays pure).
 */
export function planL0(xq: XQuery, dfs: Map<string, number>): ReadPlan {
  const gateTerms = rarestFirst(
    [...new Set([...xq.must, ...xq.aspects, ...phraseTerms(xq)])],
    dfs,
  );
  return {
    level: "L0",
    gates: gateTerms.map((term) => readFor(term, xq)),
    unions: [],
    excludes: [...xq.exclude],
    postFilters: postFiltersOf(xq),
  };
}

function rarestFirst(terms: string[], dfs: Map<string, number>): string[] {
  // Unknown df = 0 = rarest; ties break lexicographically for determinism.
  return [...terms].sort((a, b) => {
    const d = (dfs.get(a) ?? 0) - (dfs.get(b) ?? 0);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

function readFor(term: string, xq: XQuery): PostingsRead {
  const f = xq.filters;
  const timeRange =
    f.since !== null || f.until !== null
      ? {
          ...(f.since !== null ? { since: f.since } : {}),
          ...(f.until !== null ? { until: f.until } : {}),
        }
      : undefined;
  if (f.authorId !== null) {
    return {
      term,
      index: "by_term_author_time",
      eq: { authorId: f.authorId },
      timeRange,
      order: "desc",
      limit: PER_TERM_CAP,
    };
  }
  if (f.media !== null && xq.sort !== "latest" && timeRange === undefined) {
    return {
      term,
      index: "by_term_media_score",
      eq: { mediaType: f.media },
      order: "desc",
      limit: PER_TERM_CAP,
    };
  }
  if (xq.sort === "latest" || timeRange !== undefined) {
    return {
      term,
      index: "by_term_time",
      timeRange,
      order: "desc",
      limit: PER_TERM_CAP,
    };
  }
  return { term, index: "by_term_score", order: "desc", limit: PER_TERM_CAP };
}

function postFiltersOf(xq: XQuery): ReadPlan["postFilters"] {
  const f = xq.filters;
  return {
    since: f.since ?? undefined,
    until: f.until ?? undefined,
    media: f.media ?? undefined,
    minLikes: f.minLikes ?? undefined,
    lang: f.lang ?? undefined,
  };
}

/**
 * Escalation: given the executed plan and how many candidates survived, produce
 * the next plan or null (done). Encodes §5.2 verbatim:
 * L0 -> L1 drop lowest-idf must term (≤2 times) -> L2 union(must∪should) ->
 * L3 PRF terms (caller mines cooccurrence, passes them in) -> stop (L4 is an action).
 * INVARIANT: filters never relax — only terms do.
 */
export function escalate(
  executed: ReadPlan,
  survivors: number,
  xq: XQuery,
  dfs: Map<string, number>,
  prfTerms?: string[],
): ReadPlan | null {
  if (survivors >= MIN_RESULTS) return null;

  // L0/L1 -> L1: drop the lowest-idf (= highest-df) gate, at most twice, and only
  // while more than one gate remains. Filters ride along untouched (invariant 2).
  if (executed.level === "L0" || executed.level === "L1") {
    const fullGateCount = new Set([...xq.must, ...xq.aspects, ...phraseTerms(xq)]).size;
    const drops = fullGateCount - executed.gates.length;
    const protectedTerms = new Set([...xq.aspects, ...phraseTerms(xq)]);
    const droppable = executed.gates.filter((gate) =>
      xq.must.includes(gate.term) && !protectedTerms.has(gate.term),
    );
    const toDrop = droppable.at(-1);
    if (executed.gates.length > 1 && drops < 2 && toDrop !== undefined) {
      return {
        ...executed,
        level: "L1",
        gates: executed.gates.filter((gate) => gate.term !== toDrop.term),
      };
    }
    return escalateToL2(xq, dfs);
  }

  // L2 -> L3: PRF terms (mined by the caller from the docs found so far) join the
  // union. Without terms to add there is nothing left to relax in a query.
  if (executed.level === "L2" && prfTerms !== undefined && prfTerms.length > 0) {
    const known = new Set(executed.unions.map((u) => u.term));
    const extra = rarestFirst(
      prfTerms.filter((t) => !known.has(t)),
      dfs,
    );
    if (extra.length === 0) return null;
    return {
      ...executed,
      level: "L3",
      unions: [...executed.unions, ...extra.map((t) => readFor(t, xq))],
    };
  }

  return null; // L4 (vectors) is an action, not a plan
}

function escalateToL2(xq: XQuery, dfs: Map<string, number>): ReadPlan | null {
  const unionTerms = rarestFirst(
    [...new Set([...xq.must, ...xq.should, ...xq.aspects, ...phraseTerms(xq)])],
    dfs,
  );
  if (unionTerms.length === 0) return null;
  return {
    level: "L2",
    gates: [],
    unions: unionTerms.map((t) => readFor(t, xq)),
    excludes: [...xq.exclude],
    postFilters: postFiltersOf(xq),
  };
}

/** Stopwords stay in phrase verification, but have no index postings. */
export function phraseTerms(xq: XQuery): string[] {
  return xq.phrases.flatMap((phrase) => tokenize(phrase.join(" ")).tokens);
}

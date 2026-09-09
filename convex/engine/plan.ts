// Ladder planner (DESIGN §5). Pure: XQuery -> ReadPlan. search.ts executes plans
// against ctx.db and feeds row counts back to `escalate` — the planner never reads.
// Why: ladder logic stays unit-testable, and "bounded reads" is enforced by the
// type: a PostingsRead without a `limit` does not compile.

import { SortOrder, type XQuery } from "./xquery";
import type { AuthorId, Term } from "../contracts/ids";
import { tokenize } from "./tokenize";

export const PER_TERM_CAP = 500; // 12 query terms + 5 PRF terms, cached across levels
export const MIN_RESULTS = 10; // ladder escalation threshold (§5.2)
export const RERANK_CANDIDATES = 200;

/**
 * Deduped union of term lists in first-seen order. One Set, one output array —
 * the `[...new Set([...a, ...b, ...c])]` chain it replaces builds a temporary
 * array per list plus one more for the spread. Same elements, same order.
 */
export function uniqueTerms(...lists: Term[][]): Term[] {
  const seen = new Set<Term>();
  const out: Term[] = [];
  for (const list of lists) {
    for (const term of list) {
      if (!seen.has(term)) {
        seen.add(term);
        out.push(term);
      }
    }
  }
  return out;
}

export const LadderLevel = {
  L0: "L0",
  L1: "L1",
  L2: "L2",
  L3: "L3",
  L4: "L4",
  L5: "L5",
} as const;
export type LadderLevel = (typeof LadderLevel)[keyof typeof LadderLevel];

/** One bounded index read against `postings`. Maps 1:1 onto a withIndex call. */
export interface PostingsRead {
  term: Term;
  /** Which compound index serves this read — mirrors schema.ts index names. */
  index: "by_term_score" | "by_term_time" | "by_term_author_time" | "by_term_media_score";
  /** Equality prefix beyond `term` (authorId or mediaType), when the index has one. */
  eq?: { authorId?: AuthorId | undefined; mediaType?: string | undefined } | undefined;
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
  excludes: Term[];
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
export function planL0(xq: XQuery, dfs: Map<Term, number>): ReadPlan {
  const gateTerms = rarestFirst(uniqueTerms(xq.must, xq.aspects, phraseTerms(xq)), dfs);
  const gates: PostingsRead[] = [];
  for (const term of gateTerms) gates.push(readFor(term, xq));
  return {
    level: LadderLevel.L0,
    gates,
    unions: [],
    excludes: [...xq.exclude],
    postFilters: postFiltersOf(xq),
  };
}

function rarestFirst(terms: Term[], dfs: Map<Term, number>): Term[] {
  // Unknown df = 0 = rarest; ties break lexicographically for determinism.
  return [...terms].sort((a, b) => {
    const d = (dfs.get(a) ?? 0) - (dfs.get(b) ?? 0);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

function readFor(term: Term, xq: XQuery): PostingsRead {
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
  if (f.media !== null && xq.sort !== SortOrder.Latest && timeRange === undefined) {
    return {
      term,
      index: "by_term_media_score",
      eq: { mediaType: f.media },
      order: "desc",
      limit: PER_TERM_CAP,
    };
  }
  if (xq.sort === SortOrder.Latest || timeRange !== undefined) {
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
  dfs: Map<Term, number>,
  prfTerms?: Term[],
): ReadPlan | null {
  if (survivors >= MIN_RESULTS) return null;

  // L0/L1 -> L1: drop the lowest-idf (= highest-df) gate, at most twice, and only
  // while more than one gate remains. Filters ride along untouched (invariant 2).
  if (executed.level === LadderLevel.L0 || executed.level === LadderLevel.L1) {
    // Distinct-gate count only: feed one Set directly instead of building a
    // deduped array (uniqueTerms) whose elements nobody reads here.
    const gateSet = new Set<Term>();
    for (const t of xq.must) gateSet.add(t);
    for (const t of xq.aspects) gateSet.add(t);
    for (const t of phraseTerms(xq)) gateSet.add(t);
    const drops = gateSet.size - executed.gates.length;
    const protectedTerms = new Set<Term>();
    for (const t of xq.aspects) protectedTerms.add(t);
    for (const t of phraseTerms(xq)) protectedTerms.add(t);
    const droppable: PostingsRead[] = [];
    for (const gate of executed.gates) {
      if (xq.must.includes(gate.term) && !protectedTerms.has(gate.term)) {
        droppable.push(gate);
      }
    }
    const toDrop = droppable.at(-1);
    if (executed.gates.length > 1 && drops < 2 && toDrop !== undefined) {
      const gates: PostingsRead[] = [];
      for (const gate of executed.gates) {
        if (gate.term !== toDrop.term) gates.push(gate);
      }
      return { ...executed, level: LadderLevel.L1, gates };
    }
    return escalateToL2(xq, dfs);
  }

  // L2 -> L3: PRF terms (mined by the caller from the docs found so far) join the
  // union. Without terms to add there is nothing left to relax in a query.
  if (executed.level === LadderLevel.L2 && prfTerms !== undefined && prfTerms.length > 0) {
    const known = new Set<Term>();
    for (const u of executed.unions) known.add(u.term);
    const fresh: Term[] = [];
    for (const t of prfTerms) {
      if (!known.has(t)) fresh.push(t);
    }
    const extra = rarestFirst(fresh, dfs);
    if (extra.length === 0) return null;
    const unions = [...executed.unions];
    for (const t of extra) unions.push(readFor(t, xq));
    return { ...executed, level: LadderLevel.L3, unions };
  }

  return null; // L4 (vectors) is an action, not a plan
}

function escalateToL2(xq: XQuery, dfs: Map<Term, number>): ReadPlan | null {
  const unionTerms = rarestFirst(uniqueTerms(xq.must, xq.should, xq.aspects, phraseTerms(xq)), dfs);
  if (unionTerms.length === 0) return null;
  const unions: PostingsRead[] = [];
  for (const t of unionTerms) unions.push(readFor(t, xq));
  return {
    level: LadderLevel.L2,
    gates: [],
    unions,
    excludes: [...xq.exclude],
    postFilters: postFiltersOf(xq),
  };
}

/** Stopwords stay in phrase verification, but have no index postings. */
export function phraseTerms(xq: XQuery): Term[] {
  return xq.phrases.flatMap((phrase) => tokenize(phrase.join(" ")).tokens);
}

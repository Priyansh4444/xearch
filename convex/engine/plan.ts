// Ladder planner (DESIGN §5). Pure: XQuery -> ReadPlan. search.ts executes plans
// against ctx.db and feeds row counts back to `escalate` — the planner never reads.
// Why: ladder logic stays unit-testable, and "bounded reads" is enforced by the
// type: a PostingsRead without a `limit` does not compile.

import type { XQuery } from "./xquery";

export const PER_TERM_CAP = 1000; // impact-ordered cap (WAND-lite, DESIGN §5.1)
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
  eq?: { authorId?: string; mediaType?: string };
  /** createdAt range for time-ordered indexes; postFilter for score-ordered ones. */
  timeRange?: { since?: number; until?: number };
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
    since?: number;
    until?: number;
    media?: string;
    minLikes?: number;
    lang?: string;
  };
}

/**
 * L0: exact plan. Chooses per-term index by filter shape:
 * author filter -> by_term_author_time; media -> by_term_media_score;
 * sort latest OR date-window -> by_term_time; else by_term_score.
 * Terms are ordered rarest-first by caller-provided dfs (planner stays pure).
 */
export function planL0(xq: XQuery, dfs: Map<string, number>): ReadPlan {
  // TODO(implement): gate list = must ∪ aspects ∪ flattened phrases, sorted by df
  // ascending, each as one PostingsRead with PER_TERM_CAP.
  throw new Error("not implemented: planL0");
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
  // TODO(implement)
  throw new Error("not implemented: escalate");
}

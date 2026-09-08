// Tier C: the LLM semantic layer (DESIGN §4.4, docs/PARSER.md §3–4).
// An action (network I/O), table-mediated: writes queryCache; the reactive search
// query picks the refinement up automatically. Single writer per normalizedRaw.

import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * Trigger contract (PARSER §4): called by the frontend after a search whose trace
 * shows non-glue leftovers AND prose shape, or explicitly via "didn't find it?".
 * Idempotent: a cache hit returns immediately without calling the model.
 */
export const refine = internalAction({
  args: {
    raw: v.string(),
    parsedSoFarJson: v.string(), // A+B parse — the LLM may only fill, never override
    now: v.number(),
  },
  handler: async (ctx, args) => {
    // TODO(implement):
    // 1. normalizedRaw = raw.trim().toLowerCase(); cache check via runQuery.
    // 2. Build request: system prompt (PARSER §3.2, versioned string in this file),
    //    few-shots (§3.3), user msg = { raw, parsedSoFar, now, lexiconVersion }.
    // 3. Call provider with JSON-schema structured output (§3.1). Provider is an
    //    env-var'd endpoint — hosted model now, llama.cpp+GBNF later, same schema.
    // 4. Resolve entityCandidates -> authorIds via authors.by_handle (dominance
    //    rule) — the model proposes STRINGS, never ids (PARSER §3.2 rule 4).
    // 5. Validate + canonicalize (engine/xquery.parseXQueryJson) and write
    //    queryCache. On ANY failure: write nothing — A+B results stand (P5/P2).
    throw new Error("not implemented: tierC.refine (provider call)");
  },
});

/** "Report bad parse": busts the cache row and logs the case for the eval set. */
export const reportBadParse = internalAction({
  args: { raw: v.string() },
  handler: async (ctx, args) => {
    // TODO(implement): delete queryCache row; append raw to a review log table or
    // file the humans harvest into shared/fixtures/parser-golden.jsonl.
    throw new Error("not implemented: reportBadParse");
  },
});

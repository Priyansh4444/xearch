/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as engine_constraints from "../engine/constraints.js";
import type * as engine_parse from "../engine/parse.js";
import type * as engine_plan from "../engine/plan.js";
import type * as engine_rank from "../engine/rank.js";
import type * as engine_tokenize from "../engine/tokenize.js";
import type * as engine_xquery from "../engine/xquery.js";
import type * as feedback from "../feedback.js";
import type * as ingest from "../ingest.js";
import type * as search from "../search.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "engine/constraints": typeof engine_constraints;
  "engine/parse": typeof engine_parse;
  "engine/plan": typeof engine_plan;
  "engine/rank": typeof engine_rank;
  "engine/tokenize": typeof engine_tokenize;
  "engine/xquery": typeof engine_xquery;
  feedback: typeof feedback;
  ingest: typeof ingest;
  search: typeof search;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

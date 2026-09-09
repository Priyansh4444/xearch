// Pilot configuration (config/collection/pilot.json, docs/collection/01-pilot.md).
// Pure parsing and validation; the CLI owns file reads.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as Data from "effect/Data";
import { Option } from "effect";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const PILOT_CONFIG_VERSION = 2;

/** `guest` is reserved for gate-2 discovered accounts (docs/collection/01-pilot.md). */
export const COHORTS = ["origin", "core", "crew", "bigger", "org", "guest"] as const;
export type Cohort = (typeof COHORTS)[number];

export interface PilotAccount {
  /** Human-readable handle used for requests until the profile resolves. */
  handle: string;
  /** Pinned numeric user id. A live resolution to a different id pauses the account. */
  expectedUserId: string;
  cohort: Cohort;
}

export interface PilotConfig {
  version: typeof PILOT_CONFIG_VERSION;
  source: "fxtwitter";
  apiBaseUrl: string;
  apiVersion: string;
  specificationUrl: string;
  historyDays: number;
  withReplies: boolean;
  requestedPageSize: number;
  delayMs: number;
  /** Reported per-account authored-post floor. Never a stop condition. */
  coverageFloor: number;
  selectedOn: string;
  accounts: PilotAccount[];
}

const CohortSchema = Schema.Literals([...COHORTS]);
const NonEmptyTrimmedString = Schema.String.check(Schema.isMinLength(1));
const NumericUserIdSchema = Schema.String.check(Schema.isPattern(/^[0-9]+$/));
const HandleSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{1,15}$/));
const HistoryDaysSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(3_650),
);
const PageSizeSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(100),
);
const DelayMsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(60_000),
);
const CoverageFloorSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1_000_000),
);

const PilotAccountSchema = Schema.Struct({
  handle: Schema.String,
  /** Accept number only so the error can explain why string ids are required. */
  expectedUserId: Schema.Union([Schema.String, Schema.Number]),
  cohort: CohortSchema,
});

const PilotConfigSchema = Schema.Struct({
  version: Schema.Literal(PILOT_CONFIG_VERSION),
  source: Schema.Literal("fxtwitter"),
  apiBaseUrl: NonEmptyTrimmedString,
  apiVersion: NonEmptyTrimmedString,
  specificationUrl: NonEmptyTrimmedString,
  historyDays: HistoryDaysSchema,
  withReplies: Schema.Boolean,
  requestedPageSize: PageSizeSchema,
  delayMs: DelayMsSchema,
  coverageFloor: CoverageFloorSchema,
  selectedOn: NonEmptyTrimmedString,
  accounts: Schema.Array(PilotAccountSchema).check(Schema.isMinLength(1)),
});

export class PilotConfigError extends Data.TaggedError("PilotConfigError")<{
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export function parsePilotConfig(value: unknown): PilotConfig {
  return Effect.runSync(parsePilotConfigEffect(value));
}

export const parsePilotConfigEffect = Effect.fn("parsePilotConfigEffect")(function* (
  value: unknown,
  path = "<memory>",
): Effect.fn.Return<PilotConfig, PilotConfigError> {
  const parsed = Schema.decodeUnknownResult(PilotConfigSchema)(value);
  if (Result.isFailure(parsed)) {
    // SchemaError.message renders the issue tree with paths, so operators
    // see WHICH field broke, not just that the shape is wrong.
    return yield* configFail(path, `pilot config has an invalid shape: ${parsed.failure.message}`);
  }
  const config = parsed.success;
  if (config.apiBaseUrl.trim().length === 0) {
    return yield* configFail(path, "pilot config apiBaseUrl must be a non-empty string");
  }
  if (config.apiVersion.trim().length === 0) {
    return yield* configFail(path, "pilot config apiVersion must be a non-empty string");
  }
  if (config.specificationUrl.trim().length === 0) {
    return yield* configFail(path, "pilot config specificationUrl must be a non-empty string");
  }
  if (config.selectedOn.trim().length === 0) {
    return yield* configFail(path, "pilot config selectedOn must be a non-empty string");
  }

  const accounts: PilotAccount[] = [];
  const seenHandles = new Set<string>();
  const seenIds = new Set<string>();
  for (const [index, entry] of config.accounts.entries()) {
    const handle = entry.handle.replace(/^@/, "");
    if (Option.isNone(Schema.decodeUnknownOption(HandleSchema)(handle))) {
      return yield* configFail(
        path,
        `accounts[${index}].handle is not a valid X handle: ${handle}`,
      );
    }
    if (typeof entry.expectedUserId !== "string") {
      return yield* configFail(
        path,
        `accounts[${index}].expectedUserId must be a numeric string (ids exceed 2^53)`,
      );
    }
    const expectedUserId = entry.expectedUserId;
    if (Option.isNone(Schema.decodeUnknownOption(NumericUserIdSchema)(expectedUserId))) {
      return yield* configFail(
        path,
        `accounts[${index}].expectedUserId must be a numeric string (ids exceed 2^53)`,
      );
    }
    const key = handle.toLowerCase();
    if (seenHandles.has(key)) {
      return yield* configFail(path, `duplicate handle in pilot config: ${handle}`);
    }
    if (seenIds.has(expectedUserId)) {
      return yield* configFail(path, `duplicate expectedUserId in pilot config: ${expectedUserId}`);
    }
    seenHandles.add(key);
    seenIds.add(expectedUserId);
    accounts.push({ handle, expectedUserId, cohort: entry.cohort });
  }

  return {
    version: config.version,
    source: config.source,
    apiBaseUrl: config.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiVersion: config.apiVersion.trim(),
    specificationUrl: config.specificationUrl.trim(),
    historyDays: config.historyDays,
    withReplies: config.withReplies,
    requestedPageSize: config.requestedPageSize,
    delayMs: config.delayMs,
    coverageFloor: config.coverageFloor,
    selectedOn: config.selectedOn.trim(),
    accounts,
  };
});

function configFail(path: string, message: string): PilotConfigError {
  return new PilotConfigError({ message, path, cause: new Error(message) });
}

export async function loadPilotConfig(path: string): Promise<PilotConfig> {
  return Effect.runPromise(loadPilotConfigEffect(path));
}

/**
 * Load and validate a pilot config with an explicit, typed failure channel.
 * The Promise wrapper above remains for the existing CLI surface; new callers
 * should compose this Effect so file and JSON/configuration failures stay
 * distinguishable and can be retried or reported at their boundary.
 */
export const loadPilotConfigEffect = Effect.fn("loadPilotConfigEffect")(function* (
  path: string,
): Effect.fn.Return<PilotConfig, PilotConfigError> {
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new PilotConfigError({
        message: `failed to load pilot config ${path}`,
        path,
        cause,
      }),
  });
  const parsed: unknown = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new PilotConfigError({
        message: `failed to parse pilot config ${path}`,
        path,
        cause,
      }),
  });
  return yield* parsePilotConfigEffect(parsed, path);
});

/** Restrict a config to the named handles (case-insensitive), preserving config order. */
export function selectAccounts(config: PilotConfig, handles: string[] | null): PilotConfig {
  return Effect.runSync(selectAccountsEffect(config, handles));
}

export const selectAccountsEffect = Effect.fn("selectAccounts")(function* (
  config: PilotConfig,
  handles: string[] | null,
): Effect.fn.Return<PilotConfig, PilotConfigError> {
  if (handles === null || handles.length === 0) return config;
  const wanted = new Set(handles.map((handle) => handle.replace(/^@/, "").toLowerCase()));
  const accounts = config.accounts.filter((account) => wanted.has(account.handle.toLowerCase()));
  const found = new Set(accounts.map((account) => account.handle.toLowerCase()));
  const unknown = [...wanted].filter((handle) => !found.has(handle));
  if (unknown.length > 0) {
    return yield* configFail(
      "<selectAccounts>",
      `handles not in pilot config: ${unknown.join(", ")}`,
    );
  }
  return { ...config, accounts };
});

/** Canonical JSON (sorted keys) so the same config always hashes identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function configHash(config: PilotConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  const record = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(value);
  if (Option.isSome(record)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record.value).sort()) out[key] = sortKeys(record.value[key]);
    return out;
  }
  return value;
}

// Pilot configuration (config/collection/pilot.json, docs/collection/01-pilot.md).
// Pure parsing and validation; the CLI owns file reads.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Option } from "effect";
import * as Effect from "effect/Effect";
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

const PilotAccountSchema = Schema.Struct({
  handle: Schema.String,
  expectedUserId: Schema.Union([Schema.String, Schema.Number]),
  cohort: Schema.String,
});

const PilotConfigSchema = Schema.Struct({
  version: Schema.Literal(PILOT_CONFIG_VERSION),
  source: Schema.Literal("fxtwitter"),
  apiBaseUrl: Schema.String,
  apiVersion: Schema.String,
  specificationUrl: Schema.String,
  historyDays: Schema.Number,
  withReplies: Schema.Boolean,
  requestedPageSize: Schema.Number,
  delayMs: Schema.Number,
  coverageFloor: Schema.Number,
  selectedOn: Schema.String,
  accounts: Schema.Array(PilotAccountSchema),
});

export class PilotConfigError extends Error {
  readonly _tag = "PilotConfigError";

  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`failed to load pilot config ${path}`);
  }
}

export function parsePilotConfig(value: unknown): PilotConfig {
  const parsed = Schema.decodeUnknownOption(PilotConfigSchema)(value);
  if (Option.isNone(parsed)) throw new Error("pilot config has an invalid shape");
  const config = parsed.value;
  if (config.apiBaseUrl.trim().length === 0) throw new Error("pilot config apiBaseUrl must be a non-empty string");
  if (config.apiVersion.trim().length === 0) throw new Error("pilot config apiVersion must be a non-empty string");
  if (config.specificationUrl.trim().length === 0) throw new Error("pilot config specificationUrl must be a non-empty string");
  if (config.selectedOn.trim().length === 0) throw new Error("pilot config selectedOn must be a non-empty string");
  if (!Number.isInteger(config.historyDays) || config.historyDays < 1 || config.historyDays > 3_650) {
    throw new Error("pilot config historyDays must be an integer from 1 to 3650");
  }
  if (!Number.isInteger(config.requestedPageSize) || config.requestedPageSize < 1 || config.requestedPageSize > 100) {
    throw new Error("pilot config requestedPageSize must be an integer from 1 to 100");
  }
  if (!Number.isInteger(config.delayMs) || config.delayMs < 0 || config.delayMs > 60_000) {
    throw new Error("pilot config delayMs must be an integer from 0 to 60000");
  }
  if (!Number.isInteger(config.coverageFloor) || config.coverageFloor < 0 || config.coverageFloor > 1_000_000) {
    throw new Error("pilot config coverageFloor must be an integer from 0 to 1000000");
  }
  if (config.accounts.length === 0) {
    throw new Error("pilot config accounts must be a non-empty array");
  }

  const accounts: PilotAccount[] = [];
  const seenHandles = new Set<string>();
  const seenIds = new Set<string>();
  config.accounts.forEach((entry, index) => {
    const handle = entry.handle.replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      throw new Error(`accounts[${index}].handle is not a valid X handle: ${handle}`);
    }
    if (typeof entry.expectedUserId !== "string") {
      throw new Error(`accounts[${index}].expectedUserId must be a numeric string (ids exceed 2^53)`);
    }
    const expectedUserId = entry.expectedUserId;
    if (!/^[0-9]+$/.test(expectedUserId)) {
      throw new Error(`accounts[${index}].expectedUserId must be a numeric string (ids exceed 2^53)`);
    }
    const cohort = COHORTS.find((candidate) => candidate === entry.cohort);
    if (cohort === undefined) throw new Error(`accounts[${index}].cohort must be one of ${COHORTS.join(", ")}`);
    const key = handle.toLowerCase();
    if (seenHandles.has(key)) throw new Error(`duplicate handle in pilot config: ${handle}`);
    if (seenIds.has(expectedUserId)) throw new Error(`duplicate expectedUserId in pilot config: ${expectedUserId}`);
    seenHandles.add(key);
    seenIds.add(expectedUserId);
    accounts.push({ handle, expectedUserId, cohort });
  });

  return {
    version: config.version,
    source: config.source,
    apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, ""),
    apiVersion: config.apiVersion,
    specificationUrl: config.specificationUrl,
    historyDays: config.historyDays,
    withReplies: config.withReplies,
    requestedPageSize: config.requestedPageSize,
    delayMs: config.delayMs,
    coverageFloor: config.coverageFloor,
    selectedOn: config.selectedOn,
    accounts,
  };
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
export function loadPilotConfigEffect(path: string): Effect.Effect<PilotConfig, PilotConfigError> {
  const read = Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new PilotConfigError(path, cause),
  });
  return Effect.flatMap(read, (text) =>
    Effect.try({
      try: () => parsePilotConfig(JSON.parse(text) as unknown),
      catch: (cause) => new PilotConfigError(path, cause),
    }),
  );
}

/** Restrict a config to the named handles (case-insensitive), preserving config order. */
export function selectAccounts(config: PilotConfig, handles: string[] | null): PilotConfig {
  if (handles === null || handles.length === 0) return config;
  const wanted = new Set(handles.map((handle) => handle.replace(/^@/, "").toLowerCase()));
  const accounts = config.accounts.filter((account) => wanted.has(account.handle.toLowerCase()));
  const found = new Set(accounts.map((account) => account.handle.toLowerCase()));
  const unknown = [...wanted].filter((handle) => !found.has(handle));
  if (unknown.length > 0) throw new Error(`handles not in pilot config: ${unknown.join(", ")}`);
  return { ...config, accounts };
}

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

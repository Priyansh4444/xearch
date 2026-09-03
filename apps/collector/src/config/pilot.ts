// Pilot configuration (config/collection/pilot.json, docs/collection/01-pilot.md).
// Pure parsing and validation; the CLI owns file reads.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

export function parsePilotConfig(value: unknown): PilotConfig {
  if (!isRecord(value)) throw new Error("pilot config must be an object");
  if (value.version !== PILOT_CONFIG_VERSION) {
    throw new Error(`pilot config version must be ${PILOT_CONFIG_VERSION}`);
  }
  if (value.source !== "fxtwitter") throw new Error("pilot config source must be \"fxtwitter\"");
  const apiBaseUrl = requireString(value, "apiBaseUrl").replace(/\/+$/, "");
  const apiVersion = requireString(value, "apiVersion");
  const specificationUrl = requireString(value, "specificationUrl");
  const historyDays = requireInteger(value, "historyDays", 1, 3_650);
  const requestedPageSize = requireInteger(value, "requestedPageSize", 1, 100);
  const delayMs = requireInteger(value, "delayMs", 0, 60_000);
  const coverageFloor = requireInteger(value, "coverageFloor", 0, 1_000_000);
  const selectedOn = requireString(value, "selectedOn");
  if (typeof value.withReplies !== "boolean") throw new Error("pilot config withReplies must be a boolean");
  if (!Array.isArray(value.accounts) || value.accounts.length === 0) {
    throw new Error("pilot config accounts must be a non-empty array");
  }

  const accounts: PilotAccount[] = [];
  const seenHandles = new Set<string>();
  const seenIds = new Set<string>();
  value.accounts.forEach((entry, index) => {
    if (!isRecord(entry)) throw new Error(`accounts[${index}] must be an object`);
    const handle = requireString(entry, "handle").replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      throw new Error(`accounts[${index}].handle is not a valid X handle: ${handle}`);
    }
    if (typeof entry.expectedUserId !== "string" || !/^[0-9]+$/.test(entry.expectedUserId)) {
      throw new Error(`accounts[${index}].expectedUserId must be a numeric string (ids exceed 2^53)`);
    }
    const expectedUserId = entry.expectedUserId;
    if (!/^[0-9]+$/.test(expectedUserId)) {
      throw new Error(`accounts[${index}].expectedUserId must be a numeric string (ids exceed 2^53)`);
    }
    const cohort = entry.cohort;
    if (!isCohort(cohort)) throw new Error(`accounts[${index}].cohort must be one of ${COHORTS.join(", ")}`);
    const key = handle.toLowerCase();
    if (seenHandles.has(key)) throw new Error(`duplicate handle in pilot config: ${handle}`);
    if (seenIds.has(expectedUserId)) throw new Error(`duplicate expectedUserId in pilot config: ${expectedUserId}`);
    seenHandles.add(key);
    seenIds.add(expectedUserId);
    accounts.push({ handle, expectedUserId, cohort });
  });

  return {
    version: PILOT_CONFIG_VERSION,
    source: "fxtwitter",
    apiBaseUrl,
    apiVersion,
    specificationUrl,
    historyDays,
    withReplies: value.withReplies,
    requestedPageSize,
    delayMs,
    coverageFloor,
    selectedOn,
    accounts,
  };
}

export async function loadPilotConfig(path: string): Promise<PilotConfig> {
  return parsePilotConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
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
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function isCohort(value: unknown): value is Cohort {
  return typeof value === "string" && (COHORTS as readonly string[]).includes(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`pilot config ${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = record[field];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`pilot config ${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

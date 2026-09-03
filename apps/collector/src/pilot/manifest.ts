// Run state: the checkpoint is the single mutable source of truth during
// acquisition; the manifest is a projection of it plus normalization and
// archive results (docs/collection/01-pilot.md "Run layout").

import { execFileSync } from "node:child_process";
import type { Cohort, PilotConfig } from "../config/pilot.ts";
import { configHash } from "../config/pilot.ts";
import type { NormalizationCounts } from "../normalization/normalize.ts";
import { readJson, readJsonIfExists, writeJsonAtomic, type RunPaths } from "./layout.ts";

export const RUN_FORMAT_VERSION = 2;

export const ARCHIVE_NOTICE =
  "Archived means immutable and finalized, not successful. Inspect acceptance.passed and acquisition.status.";

export type AccountState = "pending" | "active" | "paused" | "completed" | "abandoned";
export type StopReason = "history_cutoff" | "cursor_exhausted";
export type PauseReason =
  | "cursor_stalled"
  | "provider_error"
  | "invalid_response"
  | "identity_mismatch"
  | "profile_not_found"
  | "profile_protected";
export type AcquisitionStatus = "in_progress" | "completed" | "partial" | "abandoned" | "failed";

export interface AccountRecord {
  requestedHandle: string;
  cohort: Cohort;
  expectedUserId: string;
  resolvedHandle: string | null;
  userId: string | null;
  state: AccountState;
  pagesCompleted: number;
  requests: number;
  retries: number;
  rowsReturned: number;
  /** Empty pages in a row that still carried a bottom cursor (transient vs real end). */
  consecutiveEmptyPages: number;
  oldestAuthoredCreatedAt: number | null;
  newestAuthoredCreatedAt: number | null;
  stopReason: StopReason | null;
  pauseReason: PauseReason | null;
  pausedAt: number | null;
  lastError: string | null;
  abandonReason: string | null;
  abandonedAt: number | null;
  /** Acquisition-only cursor state; not projected into the manifest. */
  nextPage: number;
  nextCursor: string | null;
  seenCursors: string[];
}

export interface CollectorInfo {
  revision: string;
  dirty: boolean;
  configHash: string;
}

export interface Checkpoint {
  version: typeof RUN_FORMAT_VERSION;
  runId: string;
  createdAt: number;
  updatedAt: number;
  cutoffAt: number;
  collector: CollectorInfo;
  /** Set only by the explicit run-level abandon command or an integrity failure. */
  runOverride: { status: "abandoned" | "failed"; reason: string; at: number } | null;
  acquisitionStartedAt: number | null;
  acquisitionCompletedAt: number | null;
  accounts: AccountRecord[];
}

export interface ManifestAccount extends Omit<AccountRecord, "nextPage" | "nextCursor" | "seenCursors"> {}

export interface FileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  version: typeof RUN_FORMAT_VERSION;
  runId: string;
  archiveNotice: string;
  source: { name: "fxtwitter"; apiBaseUrl: string; apiVersion: string; specificationUrl: string };
  collector: CollectorInfo;
  createdAt: number;
  updatedAt: number;
  historyDays: number;
  cutoffAt: number;
  coverageFloor: number;
  acquisition: {
    status: AcquisitionStatus;
    startedAt: number | null;
    completedAt: number | null;
    accounts: ManifestAccount[];
  };
  normalization: { normalizedAt: number; counts: NormalizationCounts } | null;
  archive: { archivedAt: number; files: FileDigest[] } | null;
  acceptance: { passed: boolean; reasons: string[] };
}

export function newCheckpoint(config: PilotConfig, runId: string, now: number): Checkpoint {
  return {
    version: RUN_FORMAT_VERSION,
    runId,
    createdAt: now,
    updatedAt: now,
    cutoffAt: now - config.historyDays * 86_400_000,
    collector: { ...collectorRevision(), configHash: configHash(config) },
    runOverride: null,
    acquisitionStartedAt: null,
    acquisitionCompletedAt: null,
    accounts: config.accounts.map((account) => ({
      requestedHandle: account.handle,
      cohort: account.cohort,
      expectedUserId: account.expectedUserId,
      resolvedHandle: null,
      userId: null,
      state: "pending",
      pagesCompleted: 0,
      requests: 0,
      retries: 0,
      rowsReturned: 0,
      consecutiveEmptyPages: 0,
      oldestAuthoredCreatedAt: null,
      newestAuthoredCreatedAt: null,
      stopReason: null,
      pauseReason: null,
      pausedAt: null,
      lastError: null,
      abandonReason: null,
      abandonedAt: null,
      nextPage: 1,
      nextCursor: null,
      seenCursors: [],
    })),
  };
}

export function acquisitionStatus(checkpoint: Checkpoint): AcquisitionStatus {
  if (checkpoint.runOverride !== null) return checkpoint.runOverride.status;
  const states = checkpoint.accounts.map((account) => account.state);
  if (states.some((state) => state === "pending" || state === "active" || state === "paused")) return "in_progress";
  if (states.every((state) => state === "completed")) return "completed";
  return "partial";
}

export function isTerminal(status: AcquisitionStatus): boolean {
  return status !== "in_progress";
}

export function acceptance(checkpoint: Checkpoint, manifest: Pick<Manifest, "normalization" | "archive">): Manifest["acceptance"] {
  const reasons: string[] = [];
  const status = acquisitionStatus(checkpoint);
  if (status !== "completed") reasons.push(`acquisition status is ${status}`);
  for (const account of checkpoint.accounts) {
    if (account.state === "abandoned") {
      reasons.push(`account ${account.requestedHandle} abandoned: ${account.abandonReason ?? "no reason recorded"}`);
    } else if (account.state !== "completed") {
      reasons.push(`account ${account.requestedHandle} is ${account.state}${account.pauseReason ? ` (${account.pauseReason})` : ""}`);
    }
  }
  if (manifest.normalization === null) reasons.push("run has not been normalized");
  if (manifest.archive === null) reasons.push("run has not been archived");
  return { passed: reasons.length === 0, reasons };
}

export function projectManifest(
  checkpoint: Checkpoint,
  config: PilotConfig,
  previous: Pick<Manifest, "normalization" | "archive"> | null,
  now: number,
): Manifest {
  const partial = { normalization: previous?.normalization ?? null, archive: previous?.archive ?? null };
  return {
    version: RUN_FORMAT_VERSION,
    runId: checkpoint.runId,
    archiveNotice: ARCHIVE_NOTICE,
    source: {
      name: "fxtwitter",
      apiBaseUrl: config.apiBaseUrl,
      apiVersion: config.apiVersion,
      specificationUrl: config.specificationUrl,
    },
    collector: checkpoint.collector,
    createdAt: checkpoint.createdAt,
    updatedAt: now,
    historyDays: config.historyDays,
    cutoffAt: checkpoint.cutoffAt,
    coverageFloor: config.coverageFloor,
    acquisition: {
      status: acquisitionStatus(checkpoint),
      startedAt: checkpoint.acquisitionStartedAt,
      completedAt: checkpoint.acquisitionCompletedAt,
      accounts: checkpoint.accounts.map(({ nextPage: _p, nextCursor: _c, seenCursors: _s, ...rest }) => rest),
    },
    ...partial,
    acceptance: acceptance(checkpoint, partial),
  };
}

/** Persist checkpoint then re-render the manifest from it. */
export async function saveState(paths: RunPaths, checkpoint: Checkpoint, config: PilotConfig, now: number): Promise<Manifest> {
  checkpoint.updatedAt = now;
  await writeJsonAtomic(paths.checkpoint, checkpoint);
  const previous = await readJsonIfExists<Manifest>(paths.manifest);
  const manifest = projectManifest(checkpoint, config, previous, now);
  await writeJsonAtomic(paths.manifest, manifest);
  return manifest;
}

export async function loadCheckpoint(paths: RunPaths): Promise<Checkpoint> {
  const checkpoint = await readJson<Checkpoint>(paths.checkpoint);
  if (checkpoint.version !== RUN_FORMAT_VERSION) {
    throw new Error(`unsupported checkpoint version ${String(checkpoint.version)} at ${paths.checkpoint}`);
  }
  return checkpoint;
}

export function findAccount(checkpoint: Checkpoint, handle: string): AccountRecord {
  const key = handle.replace(/^@/, "").toLowerCase();
  const account = checkpoint.accounts.find((entry) => entry.requestedHandle.toLowerCase() === key);
  if (account === undefined) throw new Error(`account ${handle} is not part of this run`);
  return account;
}

function collectorRevision(): { revision: string; dirty: boolean } {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { revision, dirty: status.trim().length > 0 };
  } catch {
    return { revision: "unknown", dirty: true };
  }
}

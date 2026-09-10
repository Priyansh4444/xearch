// Run state: the checkpoint is the single mutable source of truth during
// acquisition; the manifest is a projection of it plus normalization and
// archive results (docs/collection/01-pilot.md "Run layout").

// oxlint-disable-next-line effecttsgo/node-builtin-import -- git plumbing has no v4 platform provider; shelling out with a forgiving fallback is the entire contract of collectorRevision below.
import { execFileSync } from "node:child_process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import { CollectorRuntime } from "../contracts/runtime.ts";
import type { Cohort, PilotConfig } from "../config/pilot.ts";
import { configHash } from "../config/pilot.ts";
import { readJsonEffect, readJsonIfExistsEffect, writeJsonAtomicEffect } from "../contracts/fs.ts";
import {
  AccountState,
  AcquisitionStatus,
  isOpenAccountState,
  type PauseReason,
  type StopReason,
} from "../contracts/run-state.ts";
import type { NormalizationCounts } from "../normalization/normalize.ts";
import type { RunPaths } from "./layout.ts";

export type {
  AccountState,
  AcquisitionStatus,
  PauseReason,
  StopReason,
} from "../contracts/run-state.ts";

export const RUN_FORMAT_VERSION = 2;

export class UnsupportedCheckpointVersionError extends Data.TaggedError(
  "UnsupportedCheckpointVersionError",
)<{
  readonly message: string;
  readonly path: string;
  readonly version: unknown;
  readonly expectedVersion: number;
}> {}

export class AccountNotFoundError extends Data.TaggedError("AccountNotFoundError")<{
  readonly message: string;
  readonly handle: string;
}> {}

export const ARCHIVE_NOTICE =
  "Archived means immutable and finalized, not successful. Inspect acceptance.passed and acquisition.status.";

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
  runOverride: {
    status: typeof AcquisitionStatus.Abandoned | typeof AcquisitionStatus.Failed;
    reason: string;
    at: number;
  } | null;
  acquisitionStartedAt: number | null;
  acquisitionCompletedAt: number | null;
  accounts: AccountRecord[];
}

export interface ManifestAccount extends Omit<
  AccountRecord,
  "nextPage" | "nextCursor" | "seenCursors"
> {}

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

export const newCheckpoint: {
  (config: PilotConfig, runId: string, now: number): Checkpoint;
  (runId: string, now: number): (config: PilotConfig) => Checkpoint;
} = dual(3, (config: PilotConfig, runId: string, now: number): Checkpoint => ({
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
    state: AccountState.Pending,
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
}));

export function acquisitionStatus(checkpoint: Checkpoint): AcquisitionStatus {
  if (checkpoint.runOverride !== null) return checkpoint.runOverride.status;
  const states = checkpoint.accounts.map((account) => account.state);
  if (states.some((state) => isOpenAccountState(state))) return AcquisitionStatus.InProgress;
  if (states.every((state) => state === AccountState.Completed)) return AcquisitionStatus.Completed;
  return AcquisitionStatus.Partial;
}

export function isTerminal(status: AcquisitionStatus): boolean {
  return status !== AcquisitionStatus.InProgress;
}

export const acceptance: {
  (
    checkpoint: Checkpoint,
    manifest: Pick<Manifest, "normalization" | "archive">,
  ): Manifest["acceptance"];
  (
    manifest: Pick<Manifest, "normalization" | "archive">,
  ): (checkpoint: Checkpoint) => Manifest["acceptance"];
} = dual(
  2,
  (
    checkpoint: Checkpoint,
    manifest: Pick<Manifest, "normalization" | "archive">,
  ): Manifest["acceptance"] => {
    const reasons: string[] = [];
    const status = acquisitionStatus(checkpoint);
    if (status !== AcquisitionStatus.Completed) reasons.push(`acquisition status is ${status}`);
    for (const account of checkpoint.accounts) {
      if (account.state === AccountState.Abandoned) {
        reasons.push(
          `account ${account.requestedHandle} abandoned: ${account.abandonReason ?? "no reason recorded"}`,
        );
      } else if (account.state !== AccountState.Completed) {
        reasons.push(
          `account ${account.requestedHandle} is ${account.state}${account.pauseReason !== null ? ` (${account.pauseReason})` : ""}`,
        );
      }
    }
    if (manifest.normalization === null) reasons.push("run has not been normalized");
    if (manifest.archive === null) reasons.push("run has not been archived");
    return { passed: reasons.length === 0, reasons };
  },
);

export const projectManifest: {
  (
    checkpoint: Checkpoint,
    config: PilotConfig,
    previous: Pick<Manifest, "normalization" | "archive"> | null,
    now: number,
  ): Manifest;
  (
    config: PilotConfig,
    previous: Pick<Manifest, "normalization" | "archive"> | null,
    now: number,
  ): (checkpoint: Checkpoint) => Manifest;
} = dual(
  4,
  (
    checkpoint: Checkpoint,
    config: PilotConfig,
    previous: Pick<Manifest, "normalization" | "archive"> | null,
    now: number,
  ): Manifest => {
    const partial = {
      normalization: previous?.normalization ?? null,
      archive: previous?.archive ?? null,
    };
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
        accounts: checkpoint.accounts.map(
          ({ nextPage: _p, nextCursor: _c, seenCursors: _s, ...rest }) => rest,
        ),
      },
      ...partial,
      acceptance: acceptance(checkpoint, partial),
    };
  },
);

/** Persist checkpoint then re-render the manifest from it. */
export const saveStateEffect = Effect.fn("saveStateEffect")(function* (
  paths: RunPaths,
  checkpoint: Checkpoint,
  config: PilotConfig,
  now: number,
) {
  checkpoint.updatedAt = now;
  yield* writeJsonAtomicEffect(paths.checkpoint, checkpoint);
  const previous = (yield* readJsonIfExistsEffect(paths.manifest)) as Manifest | null;
  const manifest = projectManifest(checkpoint, config, previous, now);
  yield* writeJsonAtomicEffect(paths.manifest, manifest);
  return manifest;
});

export const saveState: {
  (paths: RunPaths, checkpoint: Checkpoint, config: PilotConfig, now: number): Promise<Manifest>;
  (
    checkpoint: Checkpoint,
    config: PilotConfig,
    now: number,
  ): (paths: RunPaths) => Promise<Manifest>;
} = dual(
  4,
  (paths: RunPaths, checkpoint: Checkpoint, config: PilotConfig, now: number): Promise<Manifest> =>
    CollectorRuntime.runPromise(saveStateEffect(paths, checkpoint, config, now)),
);

export const loadCheckpointEffect = Effect.fn("loadCheckpointEffect")(function* (paths: RunPaths) {
  const checkpoint = (yield* readJsonEffect(paths.checkpoint)) as Checkpoint;
  if (checkpoint.version !== RUN_FORMAT_VERSION) {
    return yield* new UnsupportedCheckpointVersionError({
      message: `unsupported checkpoint version ${String(checkpoint.version)} at ${paths.checkpoint}`,
      path: paths.checkpoint,
      version: checkpoint.version,
      expectedVersion: RUN_FORMAT_VERSION,
    });
  }
  return checkpoint;
});

export function loadCheckpoint(paths: RunPaths): Promise<Checkpoint> {
  return CollectorRuntime.runPromise(loadCheckpointEffect(paths));
}

export const findAccountEffect = Effect.fn("findAccountEffect")(function* (
  checkpoint: Checkpoint,
  handle: string,
) {
  const key = handle.replace(/^@/, "").toLowerCase();
  const account = checkpoint.accounts.find((entry) => entry.requestedHandle.toLowerCase() === key);
  if (account === undefined) {
    return yield* new AccountNotFoundError({
      message: `account ${handle} is not part of this run`,
      handle,
    });
  }
  return account;
});

export const findAccount: {
  (checkpoint: Checkpoint, handle: string): AccountRecord;
  (handle: string): (checkpoint: Checkpoint) => AccountRecord;
} = dual(2, (checkpoint: Checkpoint, handle: string): AccountRecord =>
  Effect.runSync(findAccountEffect(checkpoint, handle)),
);

function collectorRevision(): { revision: string; dirty: boolean } {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { revision, dirty: status.trim().length > 0 };
  } catch {
    return { revision: "unknown", dirty: true };
  }
}

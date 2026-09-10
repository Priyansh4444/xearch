// Normalize, validate, finalize, archive, verify, abandon
// (docs/collection/01-pilot.md "Run lifecycle").

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as FileSystem from "effect/FileSystem";
import { posixPath } from "../contracts/posixPath.ts";
import { CollectorRuntime } from "../contracts/runtime.ts";
import type { PilotConfig } from "../config/pilot.ts";
import {
  fileExistsEffect,
  listFilesEffect,
  moveDirectoryEffect,
  readJsonEffect,
  readJsonIfExistsEffect,
  readTextEffect,
  sha256FileEffect,
  writeJsonAtomicEffect,
  writeTextAtomicEffect,
  FsError,
} from "../contracts/fs.ts";
import {
  normalizeOptionsFor,
  normalizePages,
  readRunPagesEffect,
  unknownRejectionCodes,
  type NormalizationCounts,
  type NormalizationResult,
} from "../normalization/normalize.ts";
import { ARCHIVE_ROOT, outputPaths, runPaths, type RunPaths } from "./layout.ts";
import {
  AccountState,
  AcquisitionStatus,
  PauseReason,
  StopReason,
  isNormalizableAcquisitionStatus,
} from "../contracts/run-state.ts";
import {
  AccountNotFoundError,
  UnsupportedCheckpointVersionError,
  acquisitionStatus,
  findAccountEffect,
  isTerminal,
  loadCheckpointEffect,
  projectManifest,
  saveStateEffect,
  type FileDigest,
  type Manifest,
} from "./manifest.ts";
import { buildReportEffect } from "./report.ts";

export class LifecycleError extends Data.TaggedError("LifecycleError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type LifecycleFailure =
  | LifecycleError
  | FsError
  | AccountNotFoundError
  | UnsupportedCheckpointVersionError;

export interface LifecycleOptions {
  dataDir: string;
  paths: RunPaths;
  config: PilotConfig;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NormalizeAndArchiveResult {
  archivedPaths: RunPaths;
  manifest: Manifest;
  counts: NormalizationCounts;
}

function lifecycleFail(message: string, cause: unknown = null): LifecycleError {
  return new LifecycleError({ message, cause });
}

function readBytesEffect(path: string): Effect.Effect<Uint8Array, FsError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFile(path);
  }).pipe(
    Effect.mapError(
      (cause) => new FsError({ message: `failed to read ${path}`, path, operation: "read", cause }),
    ),
  );
}

/** Normalize a terminal run, validate the outputs, write the report, finalize hashes, archive. */
export const normalizeAndArchiveEffect = Effect.fn("normalizeAndArchive")(function* (
  options: LifecycleOptions,
) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const { paths, config } = options;

  const checkpoint = yield* loadCheckpointEffect(paths);
  const status = acquisitionStatus(checkpoint);
  if (!isNormalizableAcquisitionStatus(status)) {
    return yield* lifecycleFail(
      `run ${checkpoint.runId} acquisition is ${status}; only completed or partial runs can be normalized`,
    );
  }

  let manifest = yield* saveStateEffect(paths, checkpoint, config, now());
  const pages = yield* readRunPagesEffect(paths, manifest);
  const result = normalizePages(pages, normalizeOptionsFor(manifest, config));
  yield* writeTextAtomicEffect(paths.ingress, result.ingress);
  yield* writeTextAtomicEffect(paths.rejections, result.rejections);
  yield* writeTextAtomicEffect(paths.duplicates, result.duplicates);
  yield* writeTextAtomicEffect(paths.skips, result.skips);
  yield* validateNormalizationEffect(paths, result);
  log(
    `run ${checkpoint.runId}: normalized ${pages.length} page(s): ${result.counts.accepted.total} accepted, ${result.counts.rejected.total} rejected, ${result.counts.duplicates} duplicates, ${result.counts.skippedOutsideWindow} outside window`,
  );

  manifest = projectManifest(
    checkpoint,
    config,
    { normalization: { normalizedAt: now(), counts: result.counts }, archive: null },
    now(),
  );
  yield* writeJsonAtomicEffect(paths.manifest, manifest);

  const report = yield* buildReportEffect(paths, manifest, result.counts);
  yield* writeJsonAtomicEffect(paths.report, report);

  const archivedPaths = yield* finalizeAndArchiveEffect(options.dataDir, paths, manifest, now());
  log(`run ${checkpoint.runId}: archived to ${archivedPaths.root}`);
  const archivedManifest = (yield* readJsonEffect(archivedPaths.manifest)) as Manifest;
  return {
    archivedPaths,
    manifest: archivedManifest,
    counts: result.counts,
  } satisfies NormalizeAndArchiveResult;
});

export function normalizeAndArchive(options: LifecycleOptions): Promise<NormalizeAndArchiveResult> {
  return CollectorRuntime.runPromise(normalizeAndArchiveEffect(options));
}

/** Compute digests for every retained file, write the final manifest, move the run to data/old. */
export const finalizeAndArchiveEffect = Effect.fn("finalizeAndArchive")(function* (
  dataDir: string,
  paths: RunPaths,
  manifest: Manifest,
  now: number,
) {
  const files = yield* digestRunEffect(paths);
  const finalManifest: Manifest = {
    ...manifest,
    updatedAt: now,
    archive: { archivedAt: now, files },
  };
  finalManifest.acceptance = manifestAcceptance(finalManifest);
  yield* writeJsonAtomicEffect(paths.manifest, finalManifest);
  const archived = runPaths(dataDir, ARCHIVE_ROOT, manifest.runId);
  yield* moveDirectoryEffect(paths.root, archived.root);
  return archived;
});

export const finalizeAndArchive: {
  (dataDir: string, paths: RunPaths, manifest: Manifest, now: number): Promise<RunPaths>;
  (paths: RunPaths, manifest: Manifest, now: number): (dataDir: string) => Promise<RunPaths>;
} = dual(
  4,
  (dataDir: string, paths: RunPaths, manifest: Manifest, now: number): Promise<RunPaths> =>
    CollectorRuntime.runPromise(finalizeAndArchiveEffect(dataDir, paths, manifest, now)),
);

const digestRunEffect = Effect.fn("digestRun")(function* (paths: RunPaths) {
  const files = yield* listFilesEffect(paths.root);
  const digests: FileDigest[] = [];
  for (const path of files) {
    if (path === "manifest.json" || path.endsWith(".tmp")) continue;
    digests.push({ path, ...(yield* sha256FileEffect(posixPath.join(paths.root, path))) });
  }
  return digests;
});

function manifestAcceptance(manifest: Manifest): Manifest["acceptance"] {
  const reasons = manifest.acceptance.reasons.filter(
    (reason) => reason !== "run has not been archived" && reason !== "run has not been normalized",
  );
  if (manifest.normalization === null) reasons.push("run has not been normalized");
  if (manifest.archive === null) reasons.push("run has not been archived");
  return { passed: reasons.length === 0, reasons };
}

/** Line counts on disk must equal the counts the normalizer reported. */
export const validateNormalizationEffect = Effect.fn("validateNormalization")(function* (
  paths: RunPaths,
  result: NormalizationResult,
) {
  const counts = result.counts;
  const checks: [string, string, number][] = [
    [paths.ingress, "ingress", counts.accepted.total + counts.authors],
    [paths.rejections, "rejections", counts.rejected.total],
    [paths.duplicates, "duplicates", counts.duplicates],
    [paths.skips, "skips", counts.skippedOutsideWindow],
  ];
  for (const [path, name, expected] of checks) {
    const actual = countLines(yield* readTextEffect(path));
    if (actual !== expected) {
      return yield* lifecycleFail(
        `${name} has ${actual} line(s) but the normalizer counted ${expected}`,
      );
    }
  }
  const unknown = unknownRejectionCodes(counts);
  if (unknown.length > 0) {
    return yield* lifecycleFail(`unknown rejection codes: ${unknown.join(", ")}`);
  }
  if (counts.accepted.total !== counts.accepted.timeline + counts.accepted.embedded) {
    return yield* lifecycleFail("accepted totals do not reconcile by origin");
  }
});

export const validateNormalization: {
  (paths: RunPaths, result: NormalizationResult): Promise<void>;
  (result: NormalizationResult): (paths: RunPaths) => Promise<void>;
} = dual(2, (paths: RunPaths, result: NormalizationResult): Promise<void> =>
  CollectorRuntime.runPromise(validateNormalizationEffect(paths, result)),
);

export interface VerifyResult {
  runId: string;
  hashesChecked: number;
  hashMismatches: string[];
  outputsCompared: string[];
  outputsDiffering: string[];
  passed: boolean;
}

/** Re-normalize an archived run into a scratch directory and compare bytes; the archive is never modified. */
export const verifyArchiveEffect = Effect.fn("verifyArchive")(function* (
  archivedPaths: RunPaths,
  scratchDir: string,
  config: PilotConfig,
) {
  const manifest = (yield* readJsonEffect(archivedPaths.manifest)) as Manifest;
  if (manifest.archive === null) {
    return yield* lifecycleFail(`run ${manifest.runId} is not archived`);
  }

  const hashMismatches: string[] = [];
  for (const file of manifest.archive.files) {
    const digest = yield* sha256FileEffect(posixPath.join(archivedPaths.root, file.path));
    if (digest.sha256 !== file.sha256 || digest.bytes !== file.bytes)
      hashMismatches.push(file.path);
  }

  const outputsCompared: string[] = [];
  const outputsDiffering: string[] = [];
  if (manifest.normalization !== null) {
    const pages = yield* readRunPagesEffect(archivedPaths, manifest);
    const result = normalizePages(pages, normalizeOptionsFor(manifest, config));
    const scratch = outputPaths(scratchDir);
    yield* writeTextAtomicEffect(scratch.ingress, result.ingress);
    yield* writeTextAtomicEffect(scratch.rejections, result.rejections);
    yield* writeTextAtomicEffect(scratch.duplicates, result.duplicates);
    yield* writeTextAtomicEffect(scratch.skips, result.skips);
    const pairs: [string, string, string][] = [
      ["ingress/records.jsonl", archivedPaths.ingress, scratch.ingress],
      ["rejections/records.jsonl", archivedPaths.rejections, scratch.rejections],
      ["duplicates/records.jsonl", archivedPaths.duplicates, scratch.duplicates],
      ["skips/records.jsonl", archivedPaths.skips, scratch.skips],
    ];
    for (const [name, archivedFile, scratchFile] of pairs) {
      outputsCompared.push(name);
      const a = yield* readBytesEffect(archivedFile);
      const b = yield* readBytesEffect(scratchFile);
      const equal = a.length === b.length && a.every((byte, index) => byte === b[index]);
      if (!equal) outputsDiffering.push(name);
    }
  }

  return {
    runId: manifest.runId,
    hashesChecked: manifest.archive.files.length,
    hashMismatches,
    outputsCompared,
    outputsDiffering,
    passed: hashMismatches.length === 0 && outputsDiffering.length === 0,
  } satisfies VerifyResult;
});

export const verifyArchive: {
  (archivedPaths: RunPaths, scratchDir: string, config: PilotConfig): Promise<VerifyResult>;
  (scratchDir: string, config: PilotConfig): (archivedPaths: RunPaths) => Promise<VerifyResult>;
} = dual(
  3,
  (archivedPaths: RunPaths, scratchDir: string, config: PilotConfig): Promise<VerifyResult> =>
    CollectorRuntime.runPromise(verifyArchiveEffect(archivedPaths, scratchDir, config)),
);

export const abandonAccountEffect = Effect.fn("abandonAccount")(function* (
  options: LifecycleOptions,
  handle: string,
  reason: string,
) {
  const now = options.now ?? Date.now;
  if (reason.trim().length === 0) {
    return yield* lifecycleFail("an abandon reason is required");
  }
  const checkpoint = yield* loadCheckpointEffect(options.paths);
  const account = yield* findAccountEffect(checkpoint, handle);
  if (account.state === AccountState.Completed) {
    return yield* lifecycleFail(`account ${handle} already completed`);
  }
  if (account.state === AccountState.Abandoned) {
    return yield* lifecycleFail(`account ${handle} already abandoned`);
  }
  account.state = AccountState.Abandoned;
  account.abandonReason = reason.trim();
  account.abandonedAt = now();
  if (isTerminal(acquisitionStatus(checkpoint))) checkpoint.acquisitionCompletedAt ??= now();
  return yield* saveStateEffect(options.paths, checkpoint, options.config, now());
});

export const abandonAccount: {
  (options: LifecycleOptions, handle: string, reason: string): Promise<Manifest>;
  (handle: string, reason: string): (options: LifecycleOptions) => Promise<Manifest>;
} = dual(3, (options: LifecycleOptions, handle: string, reason: string): Promise<Manifest> =>
  CollectorRuntime.runPromise(abandonAccountEffect(options, handle, reason)),
);

/**
 * Re-open an account that completed through cursor exhaustion so the next `acquire`
 * re-requests the cursor that produced the last (empty) page. Used after the
 * transient-empty-page fix; completed-by-cutoff accounts are never reopened.
 */
export const reopenAccountEffect = Effect.fn("reopenAccount")(function* (
  options: LifecycleOptions,
  handle: string,
  reason: string,
) {
  const now = options.now ?? Date.now;
  if (reason.trim().length === 0) {
    return yield* lifecycleFail("a reopen reason is required");
  }
  const checkpoint = yield* loadCheckpointEffect(options.paths);
  const account = yield* findAccountEffect(checkpoint, handle);
  const exhausted =
    account.state === AccountState.Completed && account.stopReason === StopReason.CursorExhausted;
  const stalled =
    account.state === AccountState.Paused && account.pauseReason === PauseReason.CursorStalled;
  if (!exhausted && !stalled) {
    return yield* lifecycleFail(
      `account ${handle} is ${account.state}${account.stopReason !== null ? ` (${account.stopReason})` : ""}${account.pauseReason !== null ? ` (${account.pauseReason})` : ""}; only cursor_exhausted or cursor_stalled accounts can be reopened`,
    );
  }
  if (account.userId === null || account.pagesCompleted === 0) {
    return yield* lifecycleFail(`account ${handle} has no retained pages to continue from`);
  }
  const lastMeta = (yield* readJsonEffect(
    posixPath.join(
      options.paths.raw,
      account.userId,
      `${String(account.pagesCompleted).padStart(6, "0")}.meta.json`,
    ),
  )) as { request: { cursor: string | null }; outputCursor: string | null };
  account.state = AccountState.Active;
  account.stopReason = null;
  account.pauseReason = null;
  account.pausedAt = null;
  account.consecutiveEmptyPages = 0;
  account.nextPage = account.pagesCompleted + 1;
  account.nextCursor = lastMeta.request.cursor;
  // We are deliberately re-requesting the last cursor; a replay of the same output
  // cursor must not be flagged as a stall.
  account.seenCursors = account.seenCursors.filter((cursor) => cursor !== lastMeta.outputCursor);
  account.lastError = `reopened: ${reason.trim()}`;
  checkpoint.acquisitionCompletedAt = null;
  return yield* saveStateEffect(options.paths, checkpoint, options.config, now());
});

export const reopenAccount: {
  (options: LifecycleOptions, handle: string, reason: string): Promise<Manifest>;
  (handle: string, reason: string): (options: LifecycleOptions) => Promise<Manifest>;
} = dual(3, (options: LifecycleOptions, handle: string, reason: string): Promise<Manifest> =>
  CollectorRuntime.runPromise(reopenAccountEffect(options, handle, reason)),
);

/** Stop the whole run on purpose; it is archived as-is with its terminal state recorded. */
export const abandonRunEffect = Effect.fn("abandonRun")(function* (
  options: LifecycleOptions,
  reason: string,
) {
  const now = options.now ?? Date.now;
  if (reason.trim().length === 0) {
    return yield* lifecycleFail("an abandon reason is required");
  }
  const checkpoint = yield* loadCheckpointEffect(options.paths);
  if (isTerminal(acquisitionStatus(checkpoint))) {
    return yield* lifecycleFail(
      `run ${checkpoint.runId} is already ${acquisitionStatus(checkpoint)}`,
    );
  }
  checkpoint.runOverride = {
    status: AcquisitionStatus.Abandoned,
    reason: reason.trim(),
    at: now(),
  };
  checkpoint.acquisitionCompletedAt = now();
  const manifest = yield* saveStateEffect(options.paths, checkpoint, options.config, now());
  return yield* finalizeAndArchiveEffect(options.dataDir, options.paths, manifest, now());
});

export const abandonRun: {
  (options: LifecycleOptions, reason: string): Promise<RunPaths>;
  (reason: string): (options: LifecycleOptions) => Promise<RunPaths>;
} = dual(2, (options: LifecycleOptions, reason: string): Promise<RunPaths> =>
  CollectorRuntime.runPromise(abandonRunEffect(options, reason)),
);

/** Locate a run by id in either root. */
export const locateRunEffect = Effect.fn("locateRun")(function* (dataDir: string, runId: string) {
  const active = runPaths(dataDir, "runs", runId);
  if (yield* fileExistsEffect(active.manifest)) return { paths: active, archived: false };
  const archived = runPaths(dataDir, ARCHIVE_ROOT, runId);
  if (yield* fileExistsEffect(archived.manifest)) return { paths: archived, archived: true };
  return null;
});

export const locateRun: {
  (dataDir: string, runId: string): Promise<{ paths: RunPaths; archived: boolean } | null>;
  (runId: string): (dataDir: string) => Promise<{ paths: RunPaths; archived: boolean } | null>;
} = dual(
  2,
  (dataDir: string, runId: string): Promise<{ paths: RunPaths; archived: boolean } | null> =>
    CollectorRuntime.runPromise(locateRunEffect(dataDir, runId)),
);

export const loadRunConfigEffect = Effect.fn("loadRunConfig")(function* (paths: RunPaths) {
  return (yield* readJsonIfExistsEffect(paths.config)) as PilotConfig | null;
});

export function loadRunConfig(paths: RunPaths): Promise<PilotConfig | null> {
  return CollectorRuntime.runPromise(loadRunConfigEffect(paths));
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").filter((line) => line.length > 0).length;
}

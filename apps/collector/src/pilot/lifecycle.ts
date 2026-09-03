// Normalize, validate, finalize, archive, verify, abandon
// (docs/collection/01-pilot.md "Run lifecycle").

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PilotConfig } from "../config/pilot.ts";
import {
  normalizeOptionsFor,
  normalizePages,
  readRunPages,
  unknownRejectionCodes,
  writeNormalizationOutput,
  type NormalizationCounts,
  type NormalizationResult,
} from "../normalization/normalize.ts";
import {
  ARCHIVE_ROOT,
  fileExists,
  listFiles,
  moveDirectory,
  outputPaths,
  readJson,
  readJsonIfExists,
  runPaths,
  sha256File,
  writeJsonAtomic,
  type RunPaths,
} from "./layout.ts";
import {
  acquisitionStatus,
  findAccount,
  isTerminal,
  loadCheckpoint,
  projectManifest,
  saveState,
  type FileDigest,
  type Manifest,
} from "./manifest.ts";
import { buildReport } from "./report.ts";

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

/** Normalize a terminal run, validate the outputs, write the report, finalize hashes, archive. */
export async function normalizeAndArchive(options: LifecycleOptions): Promise<NormalizeAndArchiveResult> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const { paths, config } = options;

  const checkpoint = await loadCheckpoint(paths);
  const status = acquisitionStatus(checkpoint);
  if (status !== "completed" && status !== "partial") {
    throw new Error(`run ${checkpoint.runId} acquisition is ${status}; only completed or partial runs can be normalized`);
  }

  let manifest = await saveState(paths, checkpoint, config, now());
  const pages = await readRunPages(paths, manifest);
  const result = normalizePages(pages, normalizeOptionsFor(manifest, config));
  await writeNormalizationOutput(paths, result);
  await validateNormalization(paths, result);
  log(
    `run ${checkpoint.runId}: normalized ${pages.length} page(s): ${result.counts.accepted.total} accepted, ${result.counts.rejected.total} rejected, ${result.counts.duplicates} duplicates, ${result.counts.skippedOutsideWindow} outside window`,
  );

  manifest = projectManifest(
    checkpoint,
    config,
    { normalization: { normalizedAt: now(), counts: result.counts }, archive: null },
    now(),
  );
  await writeJsonAtomic(paths.manifest, manifest);

  const report = await buildReport(paths, manifest, result.counts);
  await writeJsonAtomic(paths.report, report);

  const archivedPaths = await finalizeAndArchive(options.dataDir, paths, manifest, now());
  log(`run ${checkpoint.runId}: archived to ${archivedPaths.root}`);
  return { archivedPaths, manifest: await readJson<Manifest>(archivedPaths.manifest), counts: result.counts };
}

/** Compute digests for every retained file, write the final manifest, move the run to data/old. */
export async function finalizeAndArchive(dataDir: string, paths: RunPaths, manifest: Manifest, now: number): Promise<RunPaths> {
  const files = await digestRun(paths);
  const finalManifest: Manifest = {
    ...manifest,
    updatedAt: now,
    archive: { archivedAt: now, files },
  };
  finalManifest.acceptance = manifestAcceptance(finalManifest);
  await writeJsonAtomic(paths.manifest, finalManifest);
  const archived = runPaths(dataDir, ARCHIVE_ROOT, manifest.runId);
  await moveDirectory(paths.root, archived.root);
  return archived;
}

async function digestRun(paths: RunPaths): Promise<FileDigest[]> {
  const files = await listFiles(paths.root);
  const digests: FileDigest[] = [];
  for (const path of files) {
    if (path === "manifest.json" || path.endsWith(".tmp")) continue;
    digests.push({ path, ...(await sha256File(join(paths.root, path))) });
  }
  return digests;
}

function manifestAcceptance(manifest: Manifest): Manifest["acceptance"] {
  const reasons = manifest.acceptance.reasons.filter(
    (reason) => reason !== "run has not been archived" && reason !== "run has not been normalized",
  );
  if (manifest.normalization === null) reasons.push("run has not been normalized");
  if (manifest.archive === null) reasons.push("run has not been archived");
  return { passed: reasons.length === 0, reasons };
}

/** Line counts on disk must equal the counts the normalizer reported. */
export async function validateNormalization(paths: RunPaths, result: NormalizationResult): Promise<void> {
  const counts = result.counts;
  const checks: [string, string, number][] = [
    [paths.ingress, "ingress", counts.accepted.total + counts.authors],
    [paths.rejections, "rejections", counts.rejected.total],
    [paths.duplicates, "duplicates", counts.duplicates],
    [paths.skips, "skips", counts.skippedOutsideWindow],
  ];
  for (const [path, name, expected] of checks) {
    const actual = countLines(await readFile(path, "utf8"));
    if (actual !== expected) throw new Error(`${name} has ${actual} line(s) but the normalizer counted ${expected}`);
  }
  const unknown = unknownRejectionCodes(counts);
  if (unknown.length > 0) throw new Error(`unknown rejection codes: ${unknown.join(", ")}`);
  if (counts.accepted.total !== counts.accepted.timeline + counts.accepted.embedded) {
    throw new Error("accepted totals do not reconcile by origin");
  }
}

export interface VerifyResult {
  runId: string;
  hashesChecked: number;
  hashMismatches: string[];
  outputsCompared: string[];
  outputsDiffering: string[];
  passed: boolean;
}

/** Re-normalize an archived run into a scratch directory and compare bytes; the archive is never modified. */
export async function verifyArchive(archivedPaths: RunPaths, scratchDir: string, config: PilotConfig): Promise<VerifyResult> {
  const manifest = await readJson<Manifest>(archivedPaths.manifest);
  if (manifest.archive === null) throw new Error(`run ${manifest.runId} is not archived`);

  const hashMismatches: string[] = [];
  for (const file of manifest.archive.files) {
    const digest = await sha256File(join(archivedPaths.root, file.path));
    if (digest.sha256 !== file.sha256 || digest.bytes !== file.bytes) hashMismatches.push(file.path);
  }

  const outputsCompared: string[] = [];
  const outputsDiffering: string[] = [];
  if (manifest.normalization !== null) {
    const pages = await readRunPages(archivedPaths, manifest);
    const result = normalizePages(pages, normalizeOptionsFor(manifest, config));
    const scratch = outputPaths(scratchDir);
    await writeNormalizationOutput(scratch, result);
    const pairs: [string, string, string][] = [
      ["ingress/records.jsonl", archivedPaths.ingress, scratch.ingress],
      ["rejections/records.jsonl", archivedPaths.rejections, scratch.rejections],
      ["duplicates/records.jsonl", archivedPaths.duplicates, scratch.duplicates],
      ["skips/records.jsonl", archivedPaths.skips, scratch.skips],
    ];
    for (const [name, archivedFile, scratchFile] of pairs) {
      outputsCompared.push(name);
      const [a, b] = await Promise.all([readFile(archivedFile), readFile(scratchFile)]);
      if (!a.equals(b)) outputsDiffering.push(name);
    }
  }

  return {
    runId: manifest.runId,
    hashesChecked: manifest.archive.files.length,
    hashMismatches,
    outputsCompared,
    outputsDiffering,
    passed: hashMismatches.length === 0 && outputsDiffering.length === 0,
  };
}

export async function abandonAccount(options: LifecycleOptions, handle: string, reason: string): Promise<Manifest> {
  const now = options.now ?? Date.now;
  if (reason.trim().length === 0) throw new Error("an abandon reason is required");
  const checkpoint = await loadCheckpoint(options.paths);
  const account = findAccount(checkpoint, handle);
  if (account.state === "completed") throw new Error(`account ${handle} already completed`);
  if (account.state === "abandoned") throw new Error(`account ${handle} already abandoned`);
  account.state = "abandoned";
  account.abandonReason = reason.trim();
  account.abandonedAt = now();
  if (isTerminal(acquisitionStatus(checkpoint))) checkpoint.acquisitionCompletedAt ??= now();
  return saveState(options.paths, checkpoint, options.config, now());
}

/**
 * Re-open an account that completed through cursor exhaustion so the next `acquire`
 * re-requests the cursor that produced the last (empty) page. Used after the
 * transient-empty-page fix; completed-by-cutoff accounts are never reopened.
 */
export async function reopenAccount(options: LifecycleOptions, handle: string, reason: string): Promise<Manifest> {
  const now = options.now ?? Date.now;
  if (reason.trim().length === 0) throw new Error("a reopen reason is required");
  const checkpoint = await loadCheckpoint(options.paths);
  const account = findAccount(checkpoint, handle);
  const exhausted = account.state === "completed" && account.stopReason === "cursor_exhausted";
  const stalled = account.state === "paused" && account.pauseReason === "cursor_stalled";
  if (!exhausted && !stalled) {
    throw new Error(
      `account ${handle} is ${account.state}${account.stopReason ? ` (${account.stopReason})` : ""}${account.pauseReason ? ` (${account.pauseReason})` : ""}; only cursor_exhausted or cursor_stalled accounts can be reopened`,
    );
  }
  if (account.userId === null || account.pagesCompleted === 0) throw new Error(`account ${handle} has no retained pages to continue from`);
  const lastMeta = await readJson<{ request: { cursor: string | null }; outputCursor: string | null }>(
    join(options.paths.raw, account.userId, `${String(account.pagesCompleted).padStart(6, "0")}.meta.json`),
  );
  account.state = "active";
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
  return saveState(options.paths, checkpoint, options.config, now());
}

/** Stop the whole run on purpose; it is archived as-is with its terminal state recorded. */
export async function abandonRun(options: LifecycleOptions, reason: string): Promise<RunPaths> {
  const now = options.now ?? Date.now;
  if (reason.trim().length === 0) throw new Error("an abandon reason is required");
  const checkpoint = await loadCheckpoint(options.paths);
  if (isTerminal(acquisitionStatus(checkpoint))) {
    throw new Error(`run ${checkpoint.runId} is already ${acquisitionStatus(checkpoint)}`);
  }
  checkpoint.runOverride = { status: "abandoned", reason: reason.trim(), at: now() };
  checkpoint.acquisitionCompletedAt = now();
  const manifest = await saveState(options.paths, checkpoint, options.config, now());
  return finalizeAndArchive(options.dataDir, options.paths, manifest, now());
}

/** Locate a run by id in either root. */
export async function locateRun(dataDir: string, runId: string): Promise<{ paths: RunPaths; archived: boolean } | null> {
  const active = runPaths(dataDir, "runs", runId);
  if (await fileExists(active.manifest)) return { paths: active, archived: false };
  const archived = runPaths(dataDir, ARCHIVE_ROOT, runId);
  if (await fileExists(archived.manifest)) return { paths: archived, archived: true };
  return null;
}

export async function loadRunConfig(paths: RunPaths): Promise<PilotConfig | null> {
  return readJsonIfExists<PilotConfig>(paths.config);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").filter((line) => line.length > 0).length;
}

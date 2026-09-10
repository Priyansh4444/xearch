// On-disk run layout (docs/collection/01-pilot.md "Run layout"). Acquisition and
// normalization communicate only through these files.

import { dual } from "effect/Function";
import { CollectorRuntime } from "../contracts/runtime.ts";
import { posixPath } from "../contracts/posixPath.ts";
import {
  fileExistsEffect,
  listFilesEffect,
  moveDirectoryEffect,
  readJsonEffect,
  readJsonIfExistsEffect,
  sha256FileEffect,
  writeJsonAtomicEffect,
  writeTextAtomicEffect,
} from "../contracts/fs.ts";

export interface RunPaths {
  root: string;
  manifest: string;
  checkpoint: string;
  config: string;
  raw: string;
  ingress: string;
  rejections: string;
  duplicates: string;
  skips: string;
  report: string;
}

export const ACTIVE_ROOT = "runs";
export const ARCHIVE_ROOT = "old";

export const runPaths: {
  (dataDir: string, root: typeof ACTIVE_ROOT | typeof ARCHIVE_ROOT, runId: string): RunPaths;
  (root: typeof ACTIVE_ROOT | typeof ARCHIVE_ROOT, runId: string): (dataDir: string) => RunPaths;
} = dual(
  3,
  (dataDir: string, root: typeof ACTIVE_ROOT | typeof ARCHIVE_ROOT, runId: string): RunPaths => {
    const base = posixPath.join(dataDir, root, runId);
    return outputPaths(base);
  },
);

/** Paths for a run rooted at an arbitrary directory (used by verify's temp output). */
export function outputPaths(base: string): RunPaths {
  return {
    root: base,
    manifest: posixPath.join(base, "manifest.json"),
    checkpoint: posixPath.join(base, "checkpoint.json"),
    config: posixPath.join(base, "config.json"),
    raw: posixPath.join(base, "raw"),
    ingress: posixPath.join(base, "ingress", "records.jsonl"),
    rejections: posixPath.join(base, "rejections", "records.jsonl"),
    duplicates: posixPath.join(base, "duplicates", "records.jsonl"),
    skips: posixPath.join(base, "skips", "records.jsonl"),
    report: posixPath.join(base, "report.json"),
  };
}

export const accountRawDirectory: {
  (paths: RunPaths, userId: string): string;
  (userId: string): (paths: RunPaths) => string;
} = dual(2, (paths: RunPaths, userId: string): string => posixPath.join(paths.raw, userId));

export function pageFileName(page: number): string {
  return `${String(page).padStart(6, "0")}.json`;
}

export function pageMetaFileName(page: number): string {
  return `${String(page).padStart(6, "0")}.meta.json`;
}

export function pageErrorFileName(page: number): string {
  return `${String(page).padStart(6, "0")}.error.json`;
}

export const PROFILE_FILE = "profile.json";
export const PROFILE_META_FILE = "profile.meta.json";

export function createRunId(now: Date, label?: string): string;
export function createRunId(label?: string): (now: Date) => string;
export function createRunId(...args: Array<unknown>): string | ((now: Date) => string) {
  if (args[0] instanceof Date) {
    const [now, label = "pilot"] = args as [Date, string?];
    return makeRunId(now, label);
  }
  const [label = "pilot"] = args as [string?];
  return (now: Date) => makeRunId(now, label);
}

function makeRunId(now: Date, label: string): string {
  const stamp = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  return `${stamp}-${label}`;
}

export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

export const writeJsonAtomic: {
  (path: string, value: unknown): Promise<void>;
  (value: unknown): (path: string) => Promise<void>;
} = dual(2, (path: string, value: unknown): Promise<void> =>
  CollectorRuntime.runPromise(writeJsonAtomicEffect(path, value)),
);

export const writeTextAtomic: {
  (path: string, text: string): Promise<void>;
  (text: string): (path: string) => Promise<void>;
} = dual(2, (path: string, text: string): Promise<void> =>
  CollectorRuntime.runPromise(writeTextAtomicEffect(path, text)),
);

export function readJson<T = unknown>(path: string): Promise<T> {
  return CollectorRuntime.runPromise(readJsonEffect(path)) as Promise<T>;
}

export function readJsonIfExists<T = unknown>(path: string): Promise<T | null> {
  return CollectorRuntime.runPromise(readJsonIfExistsEffect(path)) as Promise<T | null>;
}

export function fileExists(path: string): Promise<boolean> {
  return CollectorRuntime.runPromise(fileExistsEffect(path));
}

export function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  return CollectorRuntime.runPromise(sha256FileEffect(path));
}

/** Every regular file under `root`, as sorted POSIX-style relative paths. */
export function listFiles(root: string): Promise<string[]> {
  return CollectorRuntime.runPromise(listFilesEffect(root));
}

/** Atomic directory move; both roots must live on the same filesystem. */
export const moveDirectory: {
  (from: string, to: string): Promise<void>;
  (to: string): (from: string) => Promise<void>;
} = dual(2, async (from: string, to: string): Promise<void> =>
  CollectorRuntime.runPromise(moveDirectoryEffect(from, to)),
);

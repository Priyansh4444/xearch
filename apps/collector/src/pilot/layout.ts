// On-disk run layout (docs/collection/01-pilot.md "Run layout"). Acquisition and
// normalization communicate only through these files.

import * as Effect from "effect/Effect";
import { join } from "node:path";
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

export function runPaths(
  dataDir: string,
  root: typeof ACTIVE_ROOT | typeof ARCHIVE_ROOT,
  runId: string,
): RunPaths {
  const base = join(dataDir, root, runId);
  return outputPaths(base);
}

/** Paths for a run rooted at an arbitrary directory (used by verify's temp output). */
export function outputPaths(base: string): RunPaths {
  return {
    root: base,
    manifest: join(base, "manifest.json"),
    checkpoint: join(base, "checkpoint.json"),
    config: join(base, "config.json"),
    raw: join(base, "raw"),
    ingress: join(base, "ingress", "records.jsonl"),
    rejections: join(base, "rejections", "records.jsonl"),
    duplicates: join(base, "duplicates", "records.jsonl"),
    skips: join(base, "skips", "records.jsonl"),
    report: join(base, "report.json"),
  };
}

export function accountRawDirectory(paths: RunPaths, userId: string): string {
  return join(paths.raw, userId);
}

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

export function createRunId(now: Date, label = "pilot"): string {
  const stamp = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  return `${stamp}-${label}`;
}

export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  return Effect.runPromise(writeJsonAtomicEffect(path, value));
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  return Effect.runPromise(writeTextAtomicEffect(path, text));
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return Effect.runPromise(readJsonEffect(path)) as Promise<T>;
}

export async function readJsonIfExists<T = unknown>(path: string): Promise<T | null> {
  return Effect.runPromise(readJsonIfExistsEffect(path)) as Promise<T | null>;
}

export async function fileExists(path: string): Promise<boolean> {
  return Effect.runPromise(fileExistsEffect(path));
}

export async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  return Effect.runPromise(sha256FileEffect(path));
}

/** Every regular file under `root`, as sorted POSIX-style relative paths. */
export async function listFiles(root: string): Promise<string[]> {
  return Effect.runPromise(listFilesEffect(root));
}

/** Atomic directory move; both roots must live on the same filesystem. */
export async function moveDirectory(from: string, to: string): Promise<void> {
  return Effect.runPromise(moveDirectoryEffect(from, to));
}

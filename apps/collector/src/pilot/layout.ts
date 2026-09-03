// On-disk run layout (docs/collection/01-pilot.md "Run layout"). Acquisition and
// normalization communicate only through these files.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

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

export function runPaths(dataDir: string, root: typeof ACTIVE_ROOT | typeof ARCHIVE_ROOT, runId: string): RunPaths {
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
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  return `${stamp}-${label}`;
}

export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, text, "utf8");
  await rename(temporaryPath, path);
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonIfExists<T = unknown>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  const buffer = await readFile(path);
  return { bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") };
}

/** Every regular file under `root`, as sorted POSIX-style relative paths. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split("\\").join("/"));
    }
  }
  await walk(root);
  return out.sort();
}

/** Atomic directory move; both roots must live on the same filesystem. */
export async function moveDirectory(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  if (await fileExists(to)) throw new Error(`destination already exists: ${to}`);
  await rename(from, to);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

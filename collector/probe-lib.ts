import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FxTwitterTimelinePage,
  TimelineClient,
  TimelineRequest,
  TimelineResponse,
} from "./fxtwitter.ts";

const CHECKPOINT_VERSION = 1;

export interface ProbeOptions {
  handle: string;
  pages: number;
  count: number;
  withReplies: boolean;
  outputDirectory: string;
  delayMs: number;
  baseUrl: string;
}

export interface PageReport {
  page: number;
  httpStatus: number;
  apiCode: number | null;
  attempts: number;
  latencyMs: number;
  resultCount: number;
  uniqueCount: number;
  duplicateCount: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  inputCursor: string | null;
  outputCursor: string | null;
  missingRequiredFields: Record<string, number>;
  kinds: {
    replies: number;
    quotes: number;
    reposts: number;
    images: number;
    videos: number;
    gifs: number;
  };
}

export interface ProbeReport {
  version: 1;
  handle: string;
  baseUrl: string;
  count: number;
  withReplies: boolean;
  startedAt: string;
  updatedAt: string;
  pagesCompleted: number;
  totalResults: number;
  uniqueTweets: number;
  duplicateTweets: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  missingRequiredFields: Record<string, number>;
  stopReason: "page-limit" | "no-content" | "no-results" | "no-next-cursor" | "repeated-cursor";
  pages: PageReport[];
}

interface ProbeCheckpoint {
  version: 1;
  identity: {
    handle: string;
    baseUrl: string;
    count: number;
    withReplies: boolean;
  };
  nextPage: number;
  nextCursor: string | null;
  seenCursors: string[];
  seenTweetIds: string[];
  completed: boolean;
  report: ProbeReport;
}

export async function runTimelineProbe(
  client: TimelineClient,
  options: ProbeOptions,
): Promise<ProbeReport> {
  validateOptions(options);
  await mkdir(join(options.outputDirectory, "raw"), { recursive: true });

  const checkpointPath = join(options.outputDirectory, "checkpoint.json");
  const reportPath = join(options.outputDirectory, "report.json");
  const checkpoint =
    (await loadCheckpoint(checkpointPath)) ?? newCheckpoint(options);
  assertCheckpointMatches(checkpoint, options);

  if (checkpoint.completed) return checkpoint.report;

  const seenTweetIds = new Set(checkpoint.seenTweetIds);
  const seenCursors = new Set(checkpoint.seenCursors ?? []);

  for (let requestIndex = 0; requestIndex < options.pages; requestIndex += 1) {
    const pageNumber = checkpoint.nextPage;
    const inputCursor = checkpoint.nextCursor;
    const request: TimelineRequest = {
      handle: options.handle,
      count: options.count,
      cursor: inputCursor,
      withReplies: options.withReplies,
    };
    const response = await client.fetchTimelinePage(request);

    await writeJson(
      join(options.outputDirectory, "raw", `${String(pageNumber).padStart(6, "0")}.json`),
      response.raw,
    );

    if (response.page === null) {
      checkpoint.report.stopReason = "no-content";
      checkpoint.report.updatedAt = new Date().toISOString();
      checkpoint.completed = true;
      await persist(checkpointPath, reportPath, checkpoint);
      break;
    }

    const pageReport = analyzeTimelinePage(
      pageNumber,
      inputCursor,
      response,
      seenTweetIds,
    );
    checkpoint.report.pages.push(pageReport);
    mergePageReport(checkpoint.report, pageReport);
    checkpoint.nextPage += 1;
    checkpoint.nextCursor = response.page.cursor.bottom;
    checkpoint.seenTweetIds = [...seenTweetIds];

    const stopReason = terminalStopReason(
      response.page,
      inputCursor,
      seenCursors,
    );
    if (response.page.cursor.bottom !== null) seenCursors.add(response.page.cursor.bottom);
    checkpoint.seenCursors = [...seenCursors];

    if (stopReason !== null) {
      checkpoint.report.stopReason = stopReason;
      checkpoint.completed = true;
    } else {
      checkpoint.report.stopReason = "page-limit";
    }
    checkpoint.report.updatedAt = new Date().toISOString();
    await persist(checkpointPath, reportPath, checkpoint);

    if (checkpoint.completed) break;
    if (requestIndex + 1 < options.pages && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  return checkpoint.report;
}

export function analyzeTimelinePage(
  pageNumber: number,
  inputCursorValue: string | null,
  response: TimelineResponse,
  seenTweetIds: Set<string>,
): PageReport {
  if (response.page === null) {
    throw new Error("Cannot analyze an empty timeline response");
  }

  const missingRequiredFields: Record<string, number> = {};
  const kinds = { replies: 0, quotes: 0, reposts: 0, images: 0, videos: 0, gifs: 0 };
  let duplicateCount = 0;
  let uniqueCount = 0;
  let oldestCreatedAt: number | null = null;
  let newestCreatedAt: number | null = null;

  for (const result of response.page.results) {
    if (!isRecord(result)) {
      increment(missingRequiredFields, "result");
      continue;
    }

    const id = nonEmptyString(result.id);
    if (id === null) {
      increment(missingRequiredFields, "id");
    } else if (seenTweetIds.has(id)) {
      duplicateCount += 1;
    } else {
      seenTweetIds.add(id);
      uniqueCount += 1;
    }

    for (const field of missingIngressFields(result)) increment(missingRequiredFields, field);

    const createdAt = timestampMilliseconds(result.created_timestamp);
    if (createdAt !== null) {
      oldestCreatedAt = oldestCreatedAt === null ? createdAt : Math.min(oldestCreatedAt, createdAt);
      newestCreatedAt = newestCreatedAt === null ? createdAt : Math.max(newestCreatedAt, createdAt);
    }

    if (isRecord(result.replying_to)) kinds.replies += 1;
    if (isRecord(result.quote) && result.quote.type !== "tombstone") kinds.quotes += 1;
    if (isRecord(result.reposted_by)) kinds.reposts += 1;

    if (isRecord(result.media) && Array.isArray(result.media.all)) {
      for (const media of result.media.all) {
        if (!isRecord(media)) continue;
        if (media.type === "photo" || media.type === "mosaic_photo") kinds.images += 1;
        else if (media.type === "video") kinds.videos += 1;
        else if (media.type === "gif") kinds.gifs += 1;
      }
    }
  }

  return {
    page: pageNumber,
    httpStatus: response.httpStatus,
    apiCode: response.page.code,
    attempts: response.attempts,
    latencyMs: Math.round(response.latencyMs * 10) / 10,
    resultCount: response.page.results.length,
    uniqueCount,
    duplicateCount,
    oldestCreatedAt,
    newestCreatedAt,
    inputCursor: cursorFingerprint(inputCursorValue),
    outputCursor: cursorFingerprint(response.page.cursor.bottom),
    missingRequiredFields,
    kinds,
  };
}

function missingIngressFields(status: Record<string, unknown>): string[] {
  const missing: string[] = [];
  requireValue(missing, "type", status.type === "status");
  requireValue(missing, "text", nonEmptyString(status.text) !== null);
  requireValue(missing, "created_timestamp", timestampMilliseconds(status.created_timestamp) !== null);
  for (const metric of ["likes", "reposts", "quotes", "replies"]) {
    requireValue(missing, metric, nonNegativeNumber(status[metric]));
  }

  if (!isRecord(status.author)) {
    missing.push("author");
  } else {
    requireValue(missing, "author.id", nonEmptyString(status.author.id) !== null);
    requireValue(missing, "author.screen_name", nonEmptyString(status.author.screen_name) !== null);
    requireValue(missing, "author.name", nonEmptyString(status.author.name) !== null);
    requireValue(missing, "author.followers", nonNegativeNumber(status.author.followers));
    requireValue(missing, "author.following", nonNegativeNumber(status.author.following));
    requireValue(missing, "author.joined", dateMilliseconds(status.author.joined) !== null);
    requireValue(
      missing,
      "author.verification.verified",
      isRecord(status.author.verification) &&
        typeof status.author.verification.verified === "boolean",
    );
  }

  return missing;
}

function terminalStopReason(
  page: FxTwitterTimelinePage,
  inputCursor: string | null,
  seenCursors: Set<string>,
): ProbeReport["stopReason"] | null {
  if (page.results.length === 0) return "no-results";
  if (page.cursor.bottom === null) return "no-next-cursor";
  if (page.cursor.bottom === inputCursor || seenCursors.has(page.cursor.bottom)) {
    return "repeated-cursor";
  }
  return null;
}

function mergePageReport(report: ProbeReport, page: PageReport): void {
  report.pagesCompleted += 1;
  report.totalResults += page.resultCount;
  report.uniqueTweets += page.uniqueCount;
  report.duplicateTweets += page.duplicateCount;
  if (page.oldestCreatedAt !== null) {
    report.oldestCreatedAt =
      report.oldestCreatedAt === null
        ? page.oldestCreatedAt
        : Math.min(report.oldestCreatedAt, page.oldestCreatedAt);
  }
  if (page.newestCreatedAt !== null) {
    report.newestCreatedAt =
      report.newestCreatedAt === null
        ? page.newestCreatedAt
        : Math.max(report.newestCreatedAt, page.newestCreatedAt);
  }
  for (const [field, count] of Object.entries(page.missingRequiredFields)) {
    report.missingRequiredFields[field] = (report.missingRequiredFields[field] ?? 0) + count;
  }
}

function newCheckpoint(options: ProbeOptions): ProbeCheckpoint {
  const now = new Date().toISOString();
  return {
    version: CHECKPOINT_VERSION,
    identity: {
      handle: options.handle,
      baseUrl: options.baseUrl,
      count: options.count,
      withReplies: options.withReplies,
    },
    nextPage: 1,
    nextCursor: null,
    seenCursors: [],
    seenTweetIds: [],
    completed: false,
    report: {
      version: CHECKPOINT_VERSION,
      handle: options.handle,
      baseUrl: options.baseUrl,
      count: options.count,
      withReplies: options.withReplies,
      startedAt: now,
      updatedAt: now,
      pagesCompleted: 0,
      totalResults: 0,
      uniqueTweets: 0,
      duplicateTweets: 0,
      oldestCreatedAt: null,
      newestCreatedAt: null,
      missingRequiredFields: {},
      stopReason: "page-limit",
      pages: [],
    },
  };
}

async function loadCheckpoint(path: string): Promise<ProbeCheckpoint | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== CHECKPOINT_VERSION) {
      throw new Error(`Unsupported checkpoint at ${path}`);
    }
    return parsed as unknown as ProbeCheckpoint;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertCheckpointMatches(checkpoint: ProbeCheckpoint, options: ProbeOptions): void {
  const expected = JSON.stringify({
    handle: options.handle,
    baseUrl: options.baseUrl,
    count: options.count,
    withReplies: options.withReplies,
  });
  if (JSON.stringify(checkpoint.identity) !== expected) {
    throw new Error(
      `Existing checkpoint options do not match this run. Choose another --out directory.`,
    );
  }
}

async function persist(
  checkpointPath: string,
  reportPath: string,
  checkpoint: ProbeCheckpoint,
): Promise<void> {
  await writeJson(reportPath, checkpoint.report);
  await writeJson(checkpointPath, checkpoint);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function validateOptions(options: ProbeOptions): void {
  if (nonEmptyString(options.handle) === null) throw new Error("handle is required");
  if (!Number.isInteger(options.pages) || options.pages < 1) {
    throw new Error("pages must be a positive integer");
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 100) {
    throw new Error("count must be an integer from 1 to 100");
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error("delayMs must be zero or greater");
  }
}

function cursorFingerprint(cursor: string | null): string | null {
  if (cursor === null) return null;
  return createHash("sha256").update(cursor).digest("hex").slice(0, 12);
}

function timestampMilliseconds(value: unknown): number | null {
  if (!nonNegativeNumber(value)) return null;
  return value >= 1_000_000_000_000 ? value : value * 1_000;
}

function dateMilliseconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requireValue(missing: string[], field: string, present: boolean): void {
  if (!present) missing.push(field);
}

function increment(counts: Record<string, number>, field: string): void {
  counts[field] = (counts[field] ?? 0) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

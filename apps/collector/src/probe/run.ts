import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Option } from "effect";
import * as Schema from "effect/Schema";
import type {
  FxTwitterTimelinePage,
  TimelineClient,
  TimelineRequest,
  TimelineResponse,
} from "../acquisition/fxtwitter.ts";
import {
  parseNonEmptyString,
  parseNonNegativeNumber,
} from "../contracts/primitives.ts";
import { parseProviderMediaType } from "../contracts/media.ts";
import { parseProviderStatus, type ProviderStatus } from "../normalization/mapping.ts";

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

const StopReasonSchema = Schema.Union([
  Schema.Literal("page-limit"),
  Schema.Literal("no-content"),
  Schema.Literal("no-results"),
  Schema.Literal("no-next-cursor"),
  Schema.Literal("repeated-cursor"),
]);

const ProbePageReportSchema = Schema.Struct({
  page: Schema.Number,
  httpStatus: Schema.Number,
  apiCode: Schema.NullOr(Schema.Number),
  attempts: Schema.Number,
  latencyMs: Schema.Number,
  resultCount: Schema.Number,
  uniqueCount: Schema.Number,
  duplicateCount: Schema.Number,
  oldestCreatedAt: Schema.NullOr(Schema.Number),
  newestCreatedAt: Schema.NullOr(Schema.Number),
  inputCursor: Schema.NullOr(Schema.String),
  outputCursor: Schema.NullOr(Schema.String),
  missingRequiredFields: Schema.Record(Schema.String, Schema.Number),
  kinds: Schema.Struct({
    replies: Schema.Number,
    quotes: Schema.Number,
    reposts: Schema.Number,
    images: Schema.Number,
    videos: Schema.Number,
    gifs: Schema.Number,
  }),
});

const ProbeReportSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: Schema.String,
  baseUrl: Schema.String,
  count: Schema.Number,
  withReplies: Schema.Boolean,
  startedAt: Schema.String,
  updatedAt: Schema.String,
  pagesCompleted: Schema.Number,
  totalResults: Schema.Number,
  uniqueTweets: Schema.Number,
  duplicateTweets: Schema.Number,
  oldestCreatedAt: Schema.NullOr(Schema.Number),
  newestCreatedAt: Schema.NullOr(Schema.Number),
  missingRequiredFields: Schema.Record(Schema.String, Schema.Number),
  stopReason: StopReasonSchema,
  pages: Schema.Array(ProbePageReportSchema),
});

const ProbeCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.Struct({
    handle: Schema.String,
    baseUrl: Schema.String,
    count: Schema.Number,
    withReplies: Schema.Boolean,
  }),
  nextPage: Schema.Number,
  nextCursor: Schema.NullOr(Schema.String),
  seenCursors: Schema.Array(Schema.String),
  seenTweetIds: Schema.Array(Schema.String),
  completed: Schema.Boolean,
  report: ProbeReportSchema,
});

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
    const status = parseProviderStatus(result);
    if (status === null) {
      increment(missingRequiredFields, "result");
      continue;
    }

    const id = parseNonEmptyString(status.id);
    if (id === null) {
      increment(missingRequiredFields, "id");
    } else if (seenTweetIds.has(id)) {
      duplicateCount += 1;
    } else {
      seenTweetIds.add(id);
      uniqueCount += 1;
    }

    for (const field of missingIngressFields(status)) increment(missingRequiredFields, field);

    const createdAt = timestampMilliseconds(status.created_timestamp);
    if (createdAt !== null) {
      oldestCreatedAt = oldestCreatedAt === null ? createdAt : Math.min(oldestCreatedAt, createdAt);
      newestCreatedAt = newestCreatedAt === null ? createdAt : Math.max(newestCreatedAt, createdAt);
    }

    if (status.replying_to !== undefined && status.replying_to !== null) kinds.replies += 1;
    const quote = parseProviderStatus(status.quote);
    if (quote !== null && quote.type !== "tombstone") kinds.quotes += 1;
    if (status.reposted_by !== undefined && status.reposted_by !== null) kinds.reposts += 1;

    if (status.media?.all !== undefined && status.media.all !== null) {
      for (const media of status.media.all) {
        const mediaType = parseProviderMediaType(media.type);
        if (mediaType === "photo" || mediaType === "mosaic_photo") kinds.images += 1;
        else if (mediaType === "video") kinds.videos += 1;
        else if (mediaType === "gif") kinds.gifs += 1;
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

function missingIngressFields(status: ProviderStatus): string[] {
  const missing: string[] = [];
  requireValue(missing, "type", status.type === "status");
  requireValue(missing, "text", parseNonEmptyString(status.text) !== null);
  requireValue(missing, "created_timestamp", timestampMilliseconds(status.created_timestamp) !== null);
  const metrics = [
    ["likes", status.likes],
    ["reposts", status.reposts],
    ["quotes", status.quotes],
    ["replies", status.replies],
  ] as const;
  for (const [metric, value] of metrics) {
    requireValue(missing, metric, parseNonNegativeNumber(value) !== null);
  }

  if (status.author === undefined || status.author === null) {
    missing.push("author");
  } else {
    requireValue(missing, "author.id", parseNonEmptyString(status.author.id) !== null);
    requireValue(missing, "author.screen_name", parseNonEmptyString(status.author.screen_name) !== null);
    requireValue(missing, "author.name", parseNonEmptyString(status.author.name) !== null);
    requireValue(missing, "author.followers", parseNonNegativeNumber(status.author.followers) !== null);
    requireValue(missing, "author.following", parseNonNegativeNumber(status.author.following) !== null);
    requireValue(missing, "author.joined", dateMilliseconds(status.author.joined) !== null);
    requireValue(missing, "author.verification.verified", status.author.verification?.verified === true || status.author.verification?.verified === false);
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
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const checkpoint = Schema.decodeUnknownOption(ProbeCheckpointSchema)(parsed);
    if (Option.isNone(checkpoint)) {
      throw new Error(`Unsupported checkpoint at ${path}`);
    }
    return {
      ...checkpoint.value,
      seenCursors: [...checkpoint.value.seenCursors],
      seenTweetIds: [...checkpoint.value.seenTweetIds],
      report: {
        ...checkpoint.value.report,
        pages: checkpoint.value.report.pages.map((page) => ({
          ...page,
          missingRequiredFields: { ...page.missingRequiredFields },
          kinds: { ...page.kinds },
        })),
        missingRequiredFields: { ...checkpoint.value.report.missingRequiredFields },
      },
    };
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
  if (parseNonEmptyString(options.handle) === null) throw new Error("handle is required");
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
  const timestamp = parseNonNegativeNumber(value);
  if (timestamp === null) return null;
  return timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1_000;
}

function dateMilliseconds(value: unknown): number | null {
  const date = parseNonEmptyString(value);
  if (date === null) return null;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireValue(missing: string[], field: string, present: boolean): void {
  if (!present) missing.push(field);
}

function increment(counts: Record<string, number>, field: string): void {
  counts[field] = (counts[field] ?? 0) + 1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

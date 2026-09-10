import { createHash } from "node:crypto";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  FxTwitterError,
  FxTwitterTimelinePage,
  PilotClient,
  TimelineRequest,
  TimelineResponse,
} from "../acquisition/fxtwitter.ts";
import { FxTwitter } from "../acquisition/fxtwitter.ts";
import { readJsonIfExistsEffect, writeJsonAtomicEffect, type FsError } from "../contracts/fs.ts";
import { parseNonEmptyString, parseNonNegativeNumber } from "../contracts/primitives.ts";
import {
  isImageProviderMedia,
  parseProviderMediaType,
  ProviderMediaType,
} from "../contracts/media.ts";
import { isStatusRow, isTombstoneRow } from "../contracts/provider.ts";
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

export class ProbeValidationError extends Data.TaggedError("ProbeValidationError")<{
  readonly message: string;
}> {}

export class ProbeCheckpointError extends Data.TaggedError("ProbeCheckpointError")<{
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export type ProbeError = ProbeValidationError | ProbeCheckpointError | FsError | FxTwitterError;

const StopReasonSchema = Schema.Union([
  Schema.Literal("page-limit"),
  Schema.Literal("no-content"),
  Schema.Literal("no-results"),
  Schema.Literal("no-next-cursor"),
  Schema.Literal("repeated-cursor"),
]);

const ProbePageReportSchema = Schema.Struct({
  page: Schema.Finite,
  httpStatus: Schema.Finite,
  apiCode: Schema.NullOr(Schema.Finite),
  attempts: Schema.Finite,
  latencyMs: Schema.Finite,
  resultCount: Schema.Finite,
  uniqueCount: Schema.Finite,
  duplicateCount: Schema.Finite,
  oldestCreatedAt: Schema.NullOr(Schema.Finite),
  newestCreatedAt: Schema.NullOr(Schema.Finite),
  inputCursor: Schema.NullOr(Schema.String),
  outputCursor: Schema.NullOr(Schema.String),
  missingRequiredFields: Schema.Record(Schema.String, Schema.Finite),
  kinds: Schema.Struct({
    replies: Schema.Finite,
    quotes: Schema.Finite,
    reposts: Schema.Finite,
    images: Schema.Finite,
    videos: Schema.Finite,
    gifs: Schema.Finite,
  }),
});

const ProbeReportSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: Schema.String,
  baseUrl: Schema.String,
  count: Schema.Finite,
  withReplies: Schema.Boolean,
  startedAt: Schema.String,
  updatedAt: Schema.String,
  pagesCompleted: Schema.Finite,
  totalResults: Schema.Finite,
  uniqueTweets: Schema.Finite,
  duplicateTweets: Schema.Finite,
  oldestCreatedAt: Schema.NullOr(Schema.Finite),
  newestCreatedAt: Schema.NullOr(Schema.Finite),
  missingRequiredFields: Schema.Record(Schema.String, Schema.Finite),
  stopReason: StopReasonSchema,
  pages: Schema.Array(ProbePageReportSchema),
});

const ProbeIdentitySchema = Schema.Struct({
  handle: Schema.String,
  baseUrl: Schema.String,
  count: Schema.Finite,
  withReplies: Schema.Boolean,
});

const ProbeIdentityJson = Schema.fromJsonString(ProbeIdentitySchema);

const ProbeCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  identity: ProbeIdentitySchema,
  nextPage: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
  seenCursors: Schema.Array(Schema.String),
  seenTweetIds: Schema.Array(Schema.String),
  completed: Schema.Boolean,
  report: ProbeReportSchema,
});

export async function runTimelineProbe(
  client: PilotClient,
  options: ProbeOptions,
): Promise<ProbeReport> {
  return Effect.runPromise(
    Effect.provideService(runTimelineProbeEffect(options), FxTwitter, client),
  );
}

export const runTimelineProbeEffect = Effect.fn("probe.runTimelineProbe")(function* (
  options: ProbeOptions,
) {
  yield* validateOptions(options);
  const client = yield* FxTwitter;

  const checkpointPath = join(options.outputDirectory, "checkpoint.json");
  const reportPath = join(options.outputDirectory, "report.json");
  const loaded = yield* loadCheckpoint(checkpointPath);
  const checkpoint = loaded ?? newCheckpoint(options, DateTime.formatIso(yield* DateTime.now));
  yield* assertCheckpointMatches(checkpoint, options);

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
    const response = yield* client.fetchTimelinePageEffect(request);

    yield* writeJsonAtomicEffect(
      join(options.outputDirectory, "raw", `${String(pageNumber).padStart(6, "0")}.json`),
      response.raw,
    );

    if (response.page === null) {
      checkpoint.report.stopReason = "no-content";
      checkpoint.report.updatedAt = DateTime.formatIso(yield* DateTime.now);
      checkpoint.completed = true;
      yield* persist(checkpointPath, reportPath, checkpoint);
      break;
    }

    const pageReport = analyzeTimelinePage(pageNumber, inputCursor, response, seenTweetIds);
    checkpoint.report.pages.push(pageReport);
    mergePageReport(checkpoint.report, pageReport);
    checkpoint.nextPage += 1;
    checkpoint.nextCursor = response.page.cursor.bottom;
    checkpoint.seenTweetIds = [...seenTweetIds];

    const stopReason = terminalStopReason(response.page, inputCursor, seenCursors);
    if (response.page.cursor.bottom !== null) seenCursors.add(response.page.cursor.bottom);
    checkpoint.seenCursors = [...seenCursors];

    if (stopReason !== null) {
      checkpoint.report.stopReason = stopReason;
      checkpoint.completed = true;
    } else {
      checkpoint.report.stopReason = "page-limit";
    }
    checkpoint.report.updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* persist(checkpointPath, reportPath, checkpoint);

    if (checkpoint.completed) break;
    if (requestIndex + 1 < options.pages && options.delayMs > 0) {
      yield* Effect.sleep(options.delayMs);
    }
  }

  return checkpoint.report;
});

export function analyzeTimelinePage(
  pageNumber: number,
  inputCursorValue: string | null,
  response: TimelineResponse,
  seenTweetIds: Set<string>,
): PageReport {
  if (response.page === null) {
    throw new ProbeValidationError({ message: "Cannot analyze an empty timeline response" });
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
    if (quote !== null && !isTombstoneRow(quote.type)) kinds.quotes += 1;
    if (status.reposted_by !== undefined && status.reposted_by !== null) kinds.reposts += 1;

    if (status.media?.all !== undefined && status.media.all !== null) {
      for (const media of status.media.all) {
        const mediaType = parseProviderMediaType(media.type);
        if (mediaType === null) continue;
        if (isImageProviderMedia(mediaType)) kinds.images += 1;
        else if (mediaType === ProviderMediaType.Video) kinds.videos += 1;
        else if (mediaType === ProviderMediaType.Gif) kinds.gifs += 1;
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
  requireValue(missing, "type", isStatusRow(status.type));
  requireValue(missing, "text", parseNonEmptyString(status.text) !== null);
  requireValue(
    missing,
    "created_timestamp",
    timestampMilliseconds(status.created_timestamp) !== null,
  );
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
    requireValue(
      missing,
      "author.screen_name",
      parseNonEmptyString(status.author.screen_name) !== null,
    );
    requireValue(missing, "author.name", parseNonEmptyString(status.author.name) !== null);
    requireValue(
      missing,
      "author.followers",
      parseNonNegativeNumber(status.author.followers) !== null,
    );
    requireValue(
      missing,
      "author.following",
      parseNonNegativeNumber(status.author.following) !== null,
    );
    requireValue(missing, "author.joined", dateMilliseconds(status.author.joined) !== null);
    requireValue(
      missing,
      "author.verification.verified",
      status.author.verification?.verified === true ||
        status.author.verification?.verified === false,
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

function newCheckpoint(options: ProbeOptions, now: string): ProbeCheckpoint {
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

const loadCheckpoint = Effect.fn("probe.loadCheckpoint")(function* (path: string) {
  const parsed = yield* readJsonIfExistsEffect(path);
  if (parsed === null) return null;

  const checkpoint = Schema.decodeUnknownOption(ProbeCheckpointSchema)(parsed);
  if (Option.isNone(checkpoint)) {
    return yield* new ProbeCheckpointError({
      message: `Unsupported checkpoint at ${path}`,
      path,
      cause: null,
    });
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
  } satisfies ProbeCheckpoint;
});

const assertCheckpointMatches = Effect.fn("probe.assertCheckpointMatches")(function* (
  checkpoint: ProbeCheckpoint,
  options: ProbeOptions,
) {
  const expected = yield* Schema.encodeEffect(ProbeIdentityJson)({
    handle: options.handle,
    baseUrl: options.baseUrl,
    count: options.count,
    withReplies: options.withReplies,
  }).pipe(Effect.orDie);
  const actual = yield* Schema.encodeEffect(ProbeIdentityJson)(checkpoint.identity).pipe(Effect.orDie);
  if (actual !== expected) {
    return yield* new ProbeCheckpointError({
      message: "Existing checkpoint options do not match this run. Choose another --out directory.",
      path: options.outputDirectory,
      cause: null,
    });
  }
});

const persist = Effect.fn("probe.persist")(function* (
  checkpointPath: string,
  reportPath: string,
  checkpoint: ProbeCheckpoint,
) {
  yield* writeJsonAtomicEffect(reportPath, checkpoint.report);
  yield* writeJsonAtomicEffect(checkpointPath, checkpoint);
});

const validateOptions = Effect.fn("probe.validateOptions")(function* (options: ProbeOptions) {
  if (parseNonEmptyString(options.handle) === null) {
    return yield* new ProbeValidationError({ message: "handle is required" });
  }
  if (!Number.isInteger(options.pages) || options.pages < 1) {
    return yield* new ProbeValidationError({ message: "pages must be a positive integer" });
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 100) {
    return yield* new ProbeValidationError({ message: "count must be an integer from 1 to 100" });
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    return yield* new ProbeValidationError({ message: "delayMs must be zero or greater" });
  }
});

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

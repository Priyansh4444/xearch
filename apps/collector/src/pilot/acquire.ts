// Resumable acquisition (docs/collection/01-pilot.md "acquisition responsibilities").
// Every provider page is retained with a .meta.json sidecar before the checkpoint
// advances. Failures pause one account; they never masquerade as completion.

import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  FxTwitterError,
  FxTwitterErrorKind,
  parseTimelineStatus,
  type FxTwitterJson,
  type PilotClient,
  type TimelineResponse,
} from "../acquisition/fxtwitter.ts";
import type { PilotConfig } from "../config/pilot.ts";
import { writeJsonAtomicEffect, type FsError } from "../contracts/fs.ts";
import type { PageMeta } from "../normalization/normalize.ts";
import { timestampMilliseconds } from "../normalization/mapping.ts";
import {
  accountRawDirectory,
  pageErrorFileName,
  pageFileName,
  pageMetaFileName,
  PROFILE_FILE,
  PROFILE_META_FILE,
  type RunPaths,
} from "./layout.ts";
import {
  AccountState,
  PageOutcome,
  PauseReason,
  StopReason,
  isFinishedAccountState,
  needsIdentityResolution,
} from "../contracts/run-state.ts";
import {
  UnsupportedCheckpointVersionError,
  acquisitionStatus,
  isTerminal,
  loadCheckpointEffect,
  newCheckpoint,
  saveStateEffect,
  type AccountRecord,
  type Checkpoint,
  type Manifest,
} from "./manifest.ts";

/** Empty pages (with a live cursor) in a row before an account counts as exhausted. */
export const EMPTY_PAGES_FOR_EXHAUSTION = 3;

export interface AcquireOptions {
  paths: RunPaths;
  config: PilotConfig;
  client: PilotClient;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  log?: (line: string) => void;
  /** Stop after this many HTTP requests (tests simulate an interruption with it). */
  maxRequests?: number | undefined;
}

type AcquireError = FsError | UnsupportedCheckpointVersionError;

export async function createRun(
  paths: RunPaths,
  config: PilotConfig,
  runId: string,
  now: number,
): Promise<Manifest> {
  return Effect.runPromise(createRunEffect(paths, config, runId, now));
}

export const createRunEffect = Effect.fn("createRunEffect")(function* (
  paths: RunPaths,
  config: PilotConfig,
  runId: string,
  now: number,
): Effect.fn.Return<Manifest, AcquireError> {
  yield* writeJsonAtomicEffect(paths.config, config);
  const checkpoint = newCheckpoint(config, runId, now);
  return yield* saveStateEffect(paths, checkpoint, config, now);
});

export async function acquire(options: AcquireOptions): Promise<Manifest> {
  return Effect.runPromise(acquireEffect(options));
}

/** Default pacing sleep, hoisted so every acquire call doesn't mint a closure. */
function defaultSleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export const acquireEffect = Effect.fn("acquireEffect")(function* (
  options: AcquireOptions,
): Effect.fn.Return<Manifest, AcquireError> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => undefined);
  const { paths, config, client } = options;

  const checkpoint = yield* loadCheckpointEffect(paths);
  if (isTerminal(acquisitionStatus(checkpoint))) {
    log(`run ${checkpoint.runId} acquisition is ${acquisitionStatus(checkpoint)}; nothing to do`);
    return yield* saveStateEffect(paths, checkpoint, config, now());
  }
  checkpoint.acquisitionStartedAt ??= now();
  yield* saveStateEffect(paths, checkpoint, config, now());

  let requests = 0;
  const budgetLeft = (): boolean =>
    options.maxRequests === undefined || requests < options.maxRequests;
  let firstRequest = true;
  const pace = Effect.fn("acquireEffect.pace")(function* (): Effect.fn.Return<void> {
    if (!firstRequest && config.delayMs > 0) {
      yield* Effect.tryPromise({
        try: () => sleep(config.delayMs),
        catch: (cause) => new Error(String(cause)),
      }).pipe(Effect.orDie);
    }
    firstRequest = false;
    requests += 1;
  });

  for (const account of checkpoint.accounts) {
    if (isFinishedAccountState(account.state)) continue;
    if (!budgetLeft()) break;

    if (account.userId === null || needsIdentityResolution(account.pauseReason)) {
      yield* pace();
      const resolved = yield* resolveIdentityEffect(account, client, paths, now, log);
      yield* saveStateEffect(paths, checkpoint, config, now());
      if (!resolved) continue;
    }

    account.state = AccountState.Active;
    account.pauseReason = null;
    account.pausedAt = null;
    yield* saveStateEffect(paths, checkpoint, config, now());

    while (budgetLeft()) {
      yield* pace();
      const outcome = yield* fetchOnePageEffect(
        account,
        client,
        paths,
        checkpoint,
        config,
        now,
        log,
      );
      yield* saveStateEffect(paths, checkpoint, config, now());
      if (outcome !== PageOutcome.Continue) break;
    }
  }

  const status = acquisitionStatus(checkpoint);
  if (isTerminal(status)) checkpoint.acquisitionCompletedAt = now();
  const manifest = yield* saveStateEffect(paths, checkpoint, config, now());
  log(
    `run ${checkpoint.runId}: acquisition ${status} after ${requests} request(s) this invocation`,
  );
  return manifest;
});

const resolveIdentityEffect = Effect.fn("resolveIdentityEffect")(function* (
  account: AccountRecord,
  client: PilotClient,
  paths: RunPaths,
  now: () => number,
  log: (line: string) => void,
): Effect.fn.Return<boolean, AcquireError> {
  account.requests += 1;
  const profileExit = yield* Effect.exit(client.fetchProfileEffect(account.requestedHandle));
  if (Exit.isFailure(profileExit)) {
    const error = Cause.squash(profileExit.cause);
    pause(account, PauseReason.ProviderError, errorMessage(error), now());
    log(`@${account.requestedHandle}: profile request failed: ${errorMessage(error)}`);
    return false;
  }
  const response = profileExit.value;
  account.retries += Math.max(0, response.attempts - 1);

  const meta = {
    version: 1,
    receivedAt: response.receivedAt,
    request: { handle: account.requestedHandle },
    httpStatus: response.httpStatus,
    attempts: response.attempts,
    latencyMs: round(response.latencyMs),
  };

  if (response.profile === null) {
    const directory = join(paths.raw, "_unresolved", account.requestedHandle.toLowerCase());
    yield* writeJsonAtomicEffect(join(directory, PROFILE_FILE), response.raw);
    yield* writeJsonAtomicEffect(join(directory, PROFILE_META_FILE), meta);
    pause(account, PauseReason.ProfileNotFound, `HTTP ${response.httpStatus}`, now());
    log(`@${account.requestedHandle}: profile not found`);
    return false;
  }

  const profile = response.profile;
  if (profile.id !== account.expectedUserId) {
    const directory = join(paths.raw, "_unresolved", account.requestedHandle.toLowerCase());
    yield* writeJsonAtomicEffect(join(directory, PROFILE_FILE), response.raw);
    yield* writeJsonAtomicEffect(join(directory, PROFILE_META_FILE), meta);
    pause(
      account,
      PauseReason.IdentityMismatch,
      `expected user id ${account.expectedUserId}, provider returned ${profile.id} (@${profile.screenName})`,
      now(),
    );
    log(
      `@${account.requestedHandle}: identity mismatch (expected ${account.expectedUserId}, got ${profile.id})`,
    );
    return false;
  }

  const directory = accountRawDirectory(paths, profile.id);
  yield* writeJsonAtomicEffect(join(directory, PROFILE_FILE), response.raw);
  yield* writeJsonAtomicEffect(join(directory, PROFILE_META_FILE), meta);
  account.userId = profile.id;
  account.resolvedHandle = profile.screenName;

  if (profile.protected) {
    pause(account, PauseReason.ProfileProtected, "profile is protected", now());
    log(`@${account.requestedHandle}: profile is protected`);
    return false;
  }
  log(`@${account.requestedHandle}: resolved to @${profile.screenName} (${profile.id})`);
  return true;
});

const fetchOnePageEffect = Effect.fn("fetchOnePageEffect")(function* (
  account: AccountRecord,
  client: PilotClient,
  paths: RunPaths,
  checkpoint: Checkpoint,
  config: PilotConfig,
  now: () => number,
  log: (line: string) => void,
): Effect.fn.Return<PageOutcome, AcquireError> {
  const userId = account.userId;
  if (userId === null) {
    return yield* Effect.die(
      new Error(`account ${account.requestedHandle} has no resolved user id`),
    );
  }
  const page = account.nextPage;
  const inputCursor = account.nextCursor;
  const directory = accountRawDirectory(paths, userId);
  const request = {
    handle: `id:${userId}`,
    count: config.requestedPageSize,
    cursor: inputCursor,
    withReplies: config.withReplies,
  };
  account.requests += 1;

  const pageExit = yield* Effect.exit(client.fetchTimelinePageEffect(request));
  if (Exit.isFailure(pageExit)) {
    const error = Cause.squash(pageExit.cause);
    const fxError = error instanceof FxTwitterError ? error : null;
    const reason: PauseReason =
      fxError?.kind === FxTwitterErrorKind.Decode
        ? PauseReason.InvalidResponse
        : PauseReason.ProviderError;
    yield* writeJsonAtomicEffect(join(directory, pageErrorFileName(page)), {
      at: now(),
      page,
      request,
      message: errorMessage(error),
      status: fxError?.status ?? null,
      responseBody: fxError !== null ? truncate(fxError.responseBody) : null,
    });
    pause(account, reason, errorMessage(error), now());
    log(`@${account.requestedHandle} page ${page}: ${reason}: ${errorMessage(error)}`);
    return PageOutcome.Stop;
  }
  const response: TimelineResponse = pageExit.value;
  account.retries += Math.max(0, response.attempts - 1);

  const meta: PageMeta = {
    version: 1,
    receivedAt: response.receivedAt,
    request: {
      accountRef: request.handle,
      count: request.count,
      cursor: inputCursor,
      withReplies: request.withReplies,
    },
    httpStatus: response.httpStatus,
    attempts: response.attempts,
    latencyMs: round(response.latencyMs),
    resultCount: response.page?.results.length ?? 0,
    outputCursor: response.page?.cursor.bottom ?? null,
  };

  if (response.page === null) {
    yield* writeJsonAtomicEffect(
      join(directory, pageMetaFileName(page).replace(".meta.json", ".no-content.meta.json")),
      meta,
    );
    complete(account, StopReason.CursorExhausted);
    log(`@${account.requestedHandle} page ${page}: 204, cursor exhausted`);
    return PageOutcome.Stop;
  }

  yield* writeJsonAtomicEffect(join(directory, pageFileName(page)), response.raw);
  yield* writeJsonAtomicEffect(join(directory, pageMetaFileName(page)), meta);

  const authored = authoredTimestamps(response.page.results, userId);
  account.pagesCompleted = page;
  account.rowsReturned += response.page.results.length;
  for (const createdAt of authored) {
    account.oldestAuthoredCreatedAt =
      account.oldestAuthoredCreatedAt === null
        ? createdAt
        : Math.min(account.oldestAuthoredCreatedAt, createdAt);
    account.newestAuthoredCreatedAt =
      account.newestAuthoredCreatedAt === null
        ? createdAt
        : Math.max(account.newestAuthoredCreatedAt, createdAt);
  }

  const bottom = response.page.cursor.bottom;
  if (bottom === null) {
    complete(account, StopReason.CursorExhausted);
    log(
      `@${account.requestedHandle} page ${page}: ${response.page.results.length} rows, null cursor, exhausted`,
    );
    return PageOutcome.Stop;
  }
  if (response.page.results.length === 0) {
    account.consecutiveEmptyPages = (account.consecutiveEmptyPages ?? 0) + 1;
    if (account.consecutiveEmptyPages >= EMPTY_PAGES_FOR_EXHAUSTION) {
      complete(account, StopReason.CursorExhausted);
      log(
        `@${account.requestedHandle} page ${page}: ${account.consecutiveEmptyPages} empty pages in a row, exhausted`,
      );
      return PageOutcome.Stop;
    }
    if (bottom === inputCursor || account.seenCursors.includes(bottom)) {
      pause(
        account,
        PauseReason.CursorStalled,
        `empty page with a repeated cursor at page ${page}`,
        now(),
      );
      log(`@${account.requestedHandle} page ${page}: empty page, cursor stalled`);
      return PageOutcome.Stop;
    }
    account.seenCursors.push(bottom);
    account.nextCursor = bottom;
    account.nextPage = page + 1;
    log(
      `@${account.requestedHandle} page ${page}: 0 rows with a live cursor (${account.consecutiveEmptyPages}/${EMPTY_PAGES_FOR_EXHAUSTION}), continuing`,
    );
    return PageOutcome.Continue;
  }
  account.consecutiveEmptyPages = 0;
  if (authored.length > 0 && authored.every((createdAt) => createdAt < checkpoint.cutoffAt)) {
    complete(account, StopReason.HistoryCutoff);
    log(
      `@${account.requestedHandle} page ${page}: ${response.page.results.length} rows, history cutoff reached`,
    );
    return PageOutcome.Stop;
  }
  if (bottom === inputCursor || account.seenCursors.includes(bottom)) {
    pause(account, PauseReason.CursorStalled, `bottom cursor repeated at page ${page}`, now());
    log(`@${account.requestedHandle} page ${page}: cursor stalled`);
    return PageOutcome.Stop;
  }

  account.seenCursors.push(bottom);
  account.nextCursor = bottom;
  account.nextPage = page + 1;
  log(
    `@${account.requestedHandle} page ${page}: ${response.page.results.length} rows (${authored.length} authored), ${round(response.latencyMs)} ms`,
  );
  return PageOutcome.Continue;
});

/** Creation times of top-level rows authored by the seed and not reposted (Q20 stop rule). */
export function authoredTimestamps(
  results: ReadonlyArray<FxTwitterJson>,
  userId: string,
): number[] {
  const out: number[] = [];
  for (const result of results) {
    const status = parseTimelineStatus(result);
    if (status === null || status.author?.id !== userId) continue;
    if (status.reposted_by !== undefined && status.reposted_by !== null) continue;
    const createdAt = timestampMilliseconds(status.created_timestamp);
    if (createdAt !== null) out.push(createdAt);
  }
  return out;
}

function complete(account: AccountRecord, reason: AccountRecord["stopReason"]): void {
  account.state = AccountState.Completed;
  account.stopReason = reason;
  account.pauseReason = null;
  account.pausedAt = null;
}

function pause(account: AccountRecord, reason: PauseReason, error: string, at: number): void {
  account.state = AccountState.Paused;
  account.pauseReason = reason;
  account.pausedAt = at;
  account.lastError = error;
}

function truncate(value: string | null): string | null {
  if (value === null) return null;
  return value.length > 65_536 ? `${value.slice(0, 65_536)}…` : value;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

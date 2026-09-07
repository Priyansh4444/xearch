// Resumable acquisition (docs/collection/01-pilot.md "acquisition responsibilities").
// Every provider page is retained with a .meta.json sidecar before the checkpoint
// advances. Failures pause one account; they never masquerade as completion.

import { join } from "node:path";
import { FxTwitterError, type PilotClient, type TimelineFetchResult } from "../acquisition/fxtwitter.ts";
import type { PilotConfig } from "../config/pilot.ts";
import type { PageMeta } from "../normalization/normalize.ts";
import { isRecord, timestampMilliseconds } from "../normalization/mapping.ts";
import {
  accountRawDirectory,
  pageErrorFileName,
  pageFileName,
  pageMetaFileName,
  PROFILE_FILE,
  PROFILE_META_FILE,
  writeJsonAtomic,
  type RunPaths,
} from "./layout.ts";
import {
  acquisitionStatus,
  isTerminal,
  loadCheckpoint,
  newCheckpoint,
  saveState,
  type AccountRecord,
  type Checkpoint,
  type Manifest,
  type PauseReason,
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
  maxRequests?: number;
}

export async function createRun(paths: RunPaths, config: PilotConfig, runId: string, now: number): Promise<Manifest> {
  await writeJsonAtomic(paths.config, config);
  const checkpoint = newCheckpoint(config, runId, now);
  return saveState(paths, checkpoint, config, now);
}

export async function acquire(options: AcquireOptions): Promise<Manifest> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const log = options.log ?? (() => undefined);
  const { paths, config, client } = options;

  const checkpoint = await loadCheckpoint(paths);
  if (isTerminal(acquisitionStatus(checkpoint))) {
    log(`run ${checkpoint.runId} acquisition is ${acquisitionStatus(checkpoint)}; nothing to do`);
    return saveState(paths, checkpoint, config, now());
  }
  checkpoint.acquisitionStartedAt ??= now();
  await saveState(paths, checkpoint, config, now());

  let requests = 0;
  const budgetLeft = (): boolean => options.maxRequests === undefined || requests < options.maxRequests;
  let firstRequest = true;
  const pace = async (): Promise<void> => {
    if (!firstRequest && config.delayMs > 0) await sleep(config.delayMs);
    firstRequest = false;
    requests += 1;
  };

  for (const account of checkpoint.accounts) {
    if (account.state === "completed" || account.state === "abandoned") continue;
    if (!budgetLeft()) break;

    if (account.userId === null || account.pauseReason === "identity_mismatch" || account.pauseReason === "profile_not_found" || account.pauseReason === "profile_protected") {
      await pace();
      const resolved = await resolveIdentity(account, client, paths, now, log);
      await saveState(paths, checkpoint, config, now());
      if (!resolved) continue;
    }

    account.state = "active";
    account.pauseReason = null;
    account.pausedAt = null;
    await saveState(paths, checkpoint, config, now());

    while (budgetLeft()) {
      await pace();
      const outcome = await fetchOnePage(account, client, paths, checkpoint, config, now, log);
      await saveState(paths, checkpoint, config, now());
      if (outcome !== "continue") break;
    }
  }

  const status = acquisitionStatus(checkpoint);
  if (isTerminal(status)) checkpoint.acquisitionCompletedAt = now();
  const manifest = await saveState(paths, checkpoint, config, now());
  log(`run ${checkpoint.runId}: acquisition ${status} after ${requests} request(s) this invocation`);
  return manifest;
}

async function resolveIdentity(
  account: AccountRecord,
  client: PilotClient,
  paths: RunPaths,
  now: () => number,
  log: (line: string) => void,
): Promise<boolean> {
  account.requests += 1;
  let response;
  try {
    response = await client.fetchProfile(account.requestedHandle);
  } catch (error) {
    pause(account, "provider_error", errorMessage(error), now());
    log(`@${account.requestedHandle}: profile request failed: ${errorMessage(error)}`);
    return false;
  }
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
    await writeJsonAtomic(join(directory, PROFILE_FILE), response.raw);
    await writeJsonAtomic(join(directory, PROFILE_META_FILE), meta);
    pause(account, "profile_not_found", `HTTP ${response.httpStatus}`, now());
    log(`@${account.requestedHandle}: profile not found`);
    return false;
  }

  const profile = response.profile;
  if (profile.id !== account.expectedUserId) {
    const directory = join(paths.raw, "_unresolved", account.requestedHandle.toLowerCase());
    await writeJsonAtomic(join(directory, PROFILE_FILE), response.raw);
    await writeJsonAtomic(join(directory, PROFILE_META_FILE), meta);
    pause(
      account,
      "identity_mismatch",
      `expected user id ${account.expectedUserId}, provider returned ${profile.id} (@${profile.screenName})`,
      now(),
    );
    log(`@${account.requestedHandle}: identity mismatch (expected ${account.expectedUserId}, got ${profile.id})`);
    return false;
  }

  const directory = accountRawDirectory(paths, profile.id);
  await writeJsonAtomic(join(directory, PROFILE_FILE), response.raw);
  await writeJsonAtomic(join(directory, PROFILE_META_FILE), meta);
  account.userId = profile.id;
  account.resolvedHandle = profile.screenName;

  if (profile.protected) {
    pause(account, "profile_protected", "profile is protected", now());
    log(`@${account.requestedHandle}: profile is protected`);
    return false;
  }
  log(`@${account.requestedHandle}: resolved to @${profile.screenName} (${profile.id})`);
  return true;
}

type PageOutcome = "continue" | "stop";

async function fetchOnePage(
  account: AccountRecord,
  client: PilotClient,
  paths: RunPaths,
  checkpoint: Checkpoint,
  config: PilotConfig,
  now: () => number,
  log: (line: string) => void,
): Promise<PageOutcome> {
  const userId = account.userId;
  if (userId === null) throw new Error(`account ${account.requestedHandle} has no resolved user id`);
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

  let response: TimelineFetchResult;
  try {
    response = await client.fetchTimelinePage(request);
  } catch (error) {
    const reason: PauseReason = error instanceof FxTwitterError && error.status === 200 ? "invalid_response" : "provider_error";
    await writeJsonAtomic(join(directory, pageErrorFileName(page)), {
      at: now(),
      page,
      request,
      message: errorMessage(error),
      status: error instanceof FxTwitterError ? error.status : null,
      responseBody: error instanceof FxTwitterError ? truncate(error.responseBody) : null,
    });
    pause(account, reason, errorMessage(error), now());
    log(`@${account.requestedHandle} page ${page}: ${reason}: ${errorMessage(error)}`);
    return "stop";
  }
  account.retries += Math.max(0, response.attempts - 1);

  const meta: PageMeta = {
    version: 1,
    receivedAt: response.receivedAt,
    request: { accountRef: request.handle, count: request.count, cursor: inputCursor, withReplies: request.withReplies },
    httpStatus: response.httpStatus,
    attempts: response.attempts,
    latencyMs: round(response.latencyMs),
    resultCount: response.page?.results.length ?? 0,
    outputCursor: response.page?.cursor.bottom ?? null,
  };

  if (response.page === null) {
    // 204: nothing newer than the request. Not a page; retain the sidecar only.
    await writeJsonAtomic(join(directory, pageMetaFileName(page).replace(".meta.json", ".no-content.meta.json")), meta);
    complete(account, "cursor_exhausted");
    log(`@${account.requestedHandle} page ${page}: 204, cursor exhausted`);
    return "stop";
  }

  await writeJsonAtomic(join(directory, pageFileName(page)), response.raw);
  await writeJsonAtomic(join(directory, pageMetaFileName(page)), meta);

  const authored = authoredTimestamps(response.page.results, userId);
  account.pagesCompleted = page;
  account.rowsReturned += response.page.results.length;
  for (const createdAt of authored) {
    account.oldestAuthoredCreatedAt = account.oldestAuthoredCreatedAt === null ? createdAt : Math.min(account.oldestAuthoredCreatedAt, createdAt);
    account.newestAuthoredCreatedAt = account.newestAuthoredCreatedAt === null ? createdAt : Math.max(account.newestAuthoredCreatedAt, createdAt);
  }

  const bottom = response.page.cursor.bottom;
  if (bottom === null) {
    complete(account, "cursor_exhausted");
    log(`@${account.requestedHandle} page ${page}: ${response.page.results.length} rows, null cursor, exhausted`);
    return "stop";
  }
  if (response.page.results.length === 0) {
    // An empty page with a live cursor is ambiguous: the provider returns transient
    // empties mid-timeline (theo, 2026-09-03). Only a run of them is the real end.
    account.consecutiveEmptyPages = (account.consecutiveEmptyPages ?? 0) + 1;
    if (account.consecutiveEmptyPages >= EMPTY_PAGES_FOR_EXHAUSTION) {
      complete(account, "cursor_exhausted");
      log(`@${account.requestedHandle} page ${page}: ${account.consecutiveEmptyPages} empty pages in a row, exhausted`);
      return "stop";
    }
    if (bottom === inputCursor || account.seenCursors.includes(bottom)) {
      pause(account, "cursor_stalled", `empty page with a repeated cursor at page ${page}`, now());
      log(`@${account.requestedHandle} page ${page}: empty page, cursor stalled`);
      return "stop";
    }
    account.seenCursors.push(bottom);
    account.nextCursor = bottom;
    account.nextPage = page + 1;
    log(`@${account.requestedHandle} page ${page}: 0 rows with a live cursor (${account.consecutiveEmptyPages}/${EMPTY_PAGES_FOR_EXHAUSTION}), continuing`);
    return "continue";
  }
  account.consecutiveEmptyPages = 0;
  if (authored.length > 0 && authored.every((createdAt) => createdAt < checkpoint.cutoffAt)) {
    complete(account, "history_cutoff");
    log(`@${account.requestedHandle} page ${page}: ${response.page.results.length} rows, history cutoff reached`);
    return "stop";
  }
  if (bottom === inputCursor || account.seenCursors.includes(bottom)) {
    pause(account, "cursor_stalled", `bottom cursor repeated at page ${page}`, now());
    log(`@${account.requestedHandle} page ${page}: cursor stalled`);
    return "stop";
  }

  account.seenCursors.push(bottom);
  account.nextCursor = bottom;
  account.nextPage = page + 1;
  log(`@${account.requestedHandle} page ${page}: ${response.page.results.length} rows (${authored.length} authored), ${round(response.latencyMs)} ms`);
  return "continue";
}

/** Creation times of top-level rows authored by the seed and not reposted (Q20 stop rule). */
export function authoredTimestamps(results: unknown[], userId: string): number[] {
  const out: number[] = [];
  for (const result of results) {
    if (!isRecord(result) || !isRecord(result.author)) continue;
    if (result.author.id !== userId || isRecord(result.reposted_by)) continue;
    const createdAt = timestampMilliseconds(result.created_timestamp);
    if (createdAt !== null) out.push(createdAt);
  }
  return out;
}

function complete(account: AccountRecord, reason: AccountRecord["stopReason"]): void {
  account.state = "completed";
  account.stopReason = reason;
  account.pauseReason = null;
  account.pausedAt = null;
}

function pause(account: AccountRecord, reason: PauseReason, error: string, at: number): void {
  account.state = "paused";
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

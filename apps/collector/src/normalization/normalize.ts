// Deterministic normalization over retained raw pages (docs/collection/01-pilot.md
// "TypeScript normalization responsibilities"). `normalizePages` is pure; the
// `*Run` helpers wrap it with filesystem access to the run layout.

import { join } from "node:path";
import type { PilotConfig } from "../config/pilot.ts";
import type { Manifest } from "../pilot/manifest.ts";
import {
  accountRawDirectory,
  pageFileName,
  pageMetaFileName,
  readJson,
  writeTextAtomic,
  type RunPaths,
} from "../pilot/layout.ts";
import {
  mapStatus,
  REJECTION_CODES,
  type CandidateOrigin,
  type IngressAuthor,
  type IngressTweet,
  type MappedCandidate,
  type MappedTweet,
  type Rejection,
} from "./mapping.ts";

export interface RawPageInput {
  accountUserId: string;
  page: number;
  rawFile: string;
  receivedAt: number;
  results: unknown[];
}

export interface NormalizeAccount {
  userId: string;
  handle: string;
}

export interface NormalizeOptions {
  cutoffAt: number;
  coverageFloor: number;
  /** Config order; defines the deterministic processing order. */
  accounts: NormalizeAccount[];
}

export interface DuplicateRecord {
  kind: "duplicate";
  tweetId: string;
  firstSeen: { accountUserId: string; page: number; origin: CandidateOrigin };
  again: { accountUserId: string; page: number; origin: CandidateOrigin };
  metricsRefreshed: boolean;
}

export interface SkipRecord {
  kind: "skip";
  reason: "outside_history_window";
  tweetId: string;
  accountUserId: string;
  page: number;
  createdAt: number;
  cutoffAt: number;
}

export interface OriginCounts {
  timeline: number;
  embedded: number;
}

export interface NormalizationCounts {
  candidates: OriginCounts;
  accepted: OriginCounts & { total: number };
  rejected: OriginCounts & { total: number; byReason: Record<string, number> };
  /** Rows on later pages of the same account whose id already appeared on an earlier page. */
  timelineRowsRepeatedWithinAccount: number;
  duplicates: number;
  metricsRefreshed: number;
  skippedOutsideWindow: number;
  tombstoneQuotes: number;
  authors: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  perAccount: {
    userId: string;
    handle: string;
    authoredAccepted: number;
    coverageFloor: number;
    coverageFloorReached: boolean;
  }[];
  perAuthor: { authorId: string; handle: string; accepted: number; share: number }[];
}

export interface NormalizationResult {
  ingress: string;
  rejections: string;
  duplicates: string;
  skips: string;
  counts: NormalizationCounts;
}

interface Occurrence {
  tweet: IngressTweet;
  origin: CandidateOrigin;
  accountUserId: string;
  page: number;
  receivedAt: number;
}

export function normalizePages(pages: RawPageInput[], options: NormalizeOptions): NormalizationResult {
  const accountOrder = new Map(options.accounts.map((account, index) => [account.userId, index]));
  const ordered = [...pages].sort((a, b) => {
    const accountDelta = (accountOrder.get(a.accountUserId) ?? Number.MAX_SAFE_INTEGER) - (accountOrder.get(b.accountUserId) ?? Number.MAX_SAFE_INTEGER);
    return accountDelta !== 0 ? accountDelta : a.page - b.page;
  });

  const occurrences = new Map<string, Occurrence>();
  const order: string[] = [];
  const authors = new Map<string, { author: IngressAuthor; receivedAt: number }>();
  const rejections: Rejection[] = [];
  const duplicates: DuplicateRecord[] = [];
  const skips: SkipRecord[] = [];
  const seenTimelineIdsByAccount = new Map<string, Set<string>>();

  const counts: NormalizationCounts = {
    candidates: { timeline: 0, embedded: 0 },
    accepted: { total: 0, timeline: 0, embedded: 0 },
    rejected: { total: 0, timeline: 0, embedded: 0, byReason: {} },
    timelineRowsRepeatedWithinAccount: 0,
    duplicates: 0,
    metricsRefreshed: 0,
    skippedOutsideWindow: 0,
    tombstoneQuotes: 0,
    authors: 0,
    oldestCreatedAt: null,
    newestCreatedAt: null,
    perAccount: [],
    perAuthor: [],
  };

  const handleCandidate = (candidate: MappedCandidate): void => {
    counts.candidates[candidate.ok ? candidate.context.origin : candidate.rejection.origin] += 1;

    if (!candidate.ok) {
      recordRejection(candidate.rejection);
    } else {
      if (candidate.quoteTombstone) counts.tombstoneQuotes += 1;
      const subjectToWindow = candidate.context.origin === "timeline" && candidate.authoredByAccount && !candidate.reposted;
      if (subjectToWindow && candidate.tweet.createdAt < options.cutoffAt) {
        counts.skippedOutsideWindow += 1;
        skips.push({
          kind: "skip",
          reason: "outside_history_window",
          tweetId: candidate.tweet.id,
          accountUserId: candidate.context.accountUserId,
          page: candidate.context.page,
          createdAt: candidate.tweet.createdAt,
          cutoffAt: options.cutoffAt,
        });
      } else {
        upsert(candidate);
      }
    }
    for (const embedded of candidate.embedded) handleCandidate(embedded);
  };

  const recordRejection = (rejection: Rejection): void => {
    rejections.push(rejection);
    counts.rejected.total += 1;
    counts.rejected[rejection.origin] += 1;
    for (const reason of rejection.reasons) {
      counts.rejected.byReason[reason] = (counts.rejected.byReason[reason] ?? 0) + 1;
    }
  };

  const upsert = (candidate: MappedTweet): void => {
    const { tweet, author, context } = candidate;
    const existing = occurrences.get(tweet.id);
    if (existing === undefined) {
      occurrences.set(tweet.id, {
        tweet,
        origin: context.origin,
        accountUserId: context.accountUserId,
        page: context.page,
        receivedAt: context.receivedAt,
      });
      order.push(tweet.id);
    } else if (existing.tweet.text !== tweet.text) {
      recordRejection({
        kind: "rejection",
        accountUserId: context.accountUserId,
        page: context.page,
        rawFile: context.rawFile,
        index: context.index,
        origin: context.origin,
        parentId: context.parentId,
        candidateId: tweet.id,
        reasons: ["conflicting_tweet_text"],
      });
      return;
    } else {
      const refresh = context.receivedAt > existing.receivedAt;
      if (refresh) {
        existing.tweet.metrics = tweet.metrics;
        existing.tweet.metricsAt = tweet.metricsAt;
        existing.receivedAt = context.receivedAt;
        counts.metricsRefreshed += 1;
      }
      counts.duplicates += 1;
      duplicates.push({
        kind: "duplicate",
        tweetId: tweet.id,
        firstSeen: { accountUserId: existing.accountUserId, page: existing.page, origin: existing.origin },
        again: { accountUserId: context.accountUserId, page: context.page, origin: context.origin },
        metricsRefreshed: refresh,
      });
    }

    const knownAuthor = authors.get(author.id);
    if (knownAuthor === undefined || context.receivedAt > knownAuthor.receivedAt) {
      authors.set(author.id, { author, receivedAt: context.receivedAt });
    }
  };

  for (const page of ordered) {
    const seenTimelineIds = seenTimelineIdsByAccount.get(page.accountUserId) ?? new Set<string>();
    seenTimelineIdsByAccount.set(page.accountUserId, seenTimelineIds);
    page.results.forEach((result, index) => {
      const candidate = mapStatus(result, {
        accountUserId: page.accountUserId,
        page: page.page,
        rawFile: page.rawFile,
        receivedAt: page.receivedAt,
        origin: "timeline",
        index,
        parentId: null,
      });
      if (candidate.ok) {
        if (seenTimelineIds.has(candidate.tweet.id)) counts.timelineRowsRepeatedWithinAccount += 1;
        else seenTimelineIds.add(candidate.tweet.id);
      }
      handleCandidate(candidate);
    });
  }

  // Emit: author before the first tweet that references it, tweets in first-seen order.
  const ingressLines: string[] = [];
  const emittedAuthors = new Set<string>();
  const perAuthor = new Map<string, number>();
  for (const id of order) {
    const occurrence = occurrences.get(id);
    if (occurrence === undefined) continue;
    const authorId = occurrence.tweet.authorId;
    if (!emittedAuthors.has(authorId)) {
      const author = authors.get(authorId);
      if (author === undefined) throw new Error(`author ${authorId} missing for accepted tweet ${id}`);
      ingressLines.push(JSON.stringify(author.author));
      emittedAuthors.add(authorId);
    }
    ingressLines.push(JSON.stringify(occurrence.tweet));
    counts.accepted.total += 1;
    counts.accepted[occurrence.origin] += 1;
    perAuthor.set(authorId, (perAuthor.get(authorId) ?? 0) + 1);
    const createdAt = occurrence.tweet.createdAt;
    counts.oldestCreatedAt = counts.oldestCreatedAt === null ? createdAt : Math.min(counts.oldestCreatedAt, createdAt);
    counts.newestCreatedAt = counts.newestCreatedAt === null ? createdAt : Math.max(counts.newestCreatedAt, createdAt);
  }
  counts.authors = emittedAuthors.size;

  counts.perAccount = options.accounts.map((account) => {
    const authoredAccepted = perAuthor.get(account.userId) ?? 0;
    return {
      userId: account.userId,
      handle: account.handle,
      authoredAccepted,
      coverageFloor: options.coverageFloor,
      coverageFloorReached: authoredAccepted >= options.coverageFloor,
    };
  });
  counts.perAuthor = [...perAuthor.entries()]
    .map(([authorId, accepted]) => ({
      authorId,
      handle: authors.get(authorId)?.author.handle ?? "",
      accepted,
      share: counts.accepted.total === 0 ? 0 : accepted / counts.accepted.total,
    }))
    .sort((a, b) => b.accepted - a.accepted || a.authorId.localeCompare(b.authorId));

  return {
    ingress: toJsonl(ingressLines),
    rejections: toJsonl(rejections.map((rejection) => JSON.stringify(rejection))),
    duplicates: toJsonl(duplicates.map((duplicate) => JSON.stringify(duplicate))),
    skips: toJsonl(skips.map((skip) => JSON.stringify(skip))),
    counts,
  };
}

export function unknownRejectionCodes(counts: NormalizationCounts): string[] {
  const known = new Set<string>(REJECTION_CODES);
  return Object.keys(counts.rejected.byReason).filter((code) => !known.has(code));
}

export interface PageMeta {
  version: 1;
  receivedAt: number;
  request: { accountRef: string; count: number; cursor: string | null; withReplies: boolean };
  httpStatus: number;
  attempts: number;
  latencyMs: number;
  resultCount: number;
  outputCursor: string | null;
}

/** Read every completed page named by the manifest, in manifest account order. */
export async function readRunPages(paths: RunPaths, manifest: Manifest): Promise<RawPageInput[]> {
  const pages: RawPageInput[] = [];
  for (const account of manifest.acquisition.accounts) {
    if (account.userId === null) continue;
    const directory = accountRawDirectory(paths, account.userId);
    for (let page = 1; page <= account.pagesCompleted; page += 1) {
      const body = await readJson<{ results?: unknown }>(join(directory, pageFileName(page)));
      const meta = await readJson<PageMeta>(join(directory, pageMetaFileName(page)));
      pages.push({
        accountUserId: account.userId,
        page,
        rawFile: `raw/${account.userId}/${pageFileName(page)}`,
        receivedAt: meta.receivedAt,
        results: Array.isArray(body?.results) ? body.results : [],
      });
    }
  }
  return pages;
}

export function normalizeOptionsFor(manifest: Manifest, config: PilotConfig): NormalizeOptions {
  return {
    cutoffAt: manifest.cutoffAt,
    coverageFloor: config.coverageFloor,
    accounts: manifest.acquisition.accounts
      .filter((account) => account.userId !== null)
      .map((account) => ({ userId: account.userId as string, handle: account.resolvedHandle ?? account.requestedHandle })),
  };
}

export async function writeNormalizationOutput(paths: RunPaths, result: NormalizationResult): Promise<void> {
  await writeTextAtomic(paths.ingress, result.ingress);
  await writeTextAtomic(paths.rejections, result.rejections);
  await writeTextAtomic(paths.duplicates, result.duplicates);
  await writeTextAtomic(paths.skips, result.skips);
}

function toJsonl(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

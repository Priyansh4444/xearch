// Pilot report (docs/collection/01-pilot.md "Acceptance criteria" #7 and the
// smoke thresholds). Built from page sidecars + normalization counts; never from
// live requests.

import { join } from "node:path";
import type { NormalizationCounts } from "../normalization/normalize.ts";
import type { PageMeta } from "../normalization/normalize.ts";
import { accountRawDirectory, pageMetaFileName, readJson, type RunPaths } from "./layout.ts";
import type { Manifest } from "./manifest.ts";

export interface ThresholdCheck {
  name: string;
  value: number | string | null;
  bound: string;
  passed: boolean | null;
}

export interface PilotReport {
  version: 1;
  runId: string;
  generatedAt: number;
  archiveNotice: string;
  acquisition: {
    status: Manifest["acquisition"]["status"];
    cutoffAt: number;
    accounts: {
      handle: string;
      resolvedHandle: string | null;
      userId: string | null;
      cohort: string;
      state: string;
      stopReason: string | null;
      pauseReason: string | null;
      pausedForMs: number | null;
      abandonReason: string | null;
      pages: number;
      requests: number;
      retries: number;
      rowsReturned: number;
      oldestAuthoredCreatedAt: number | null;
      newestAuthoredCreatedAt: number | null;
    }[];
    requests: {
      total: number;
      retries: number;
      retryRate: number | null;
      latencyMs: { mean: number | null; p50: number | null; p95: number | null; max: number | null };
      rowsPerPage: { pages: number; mean: number | null; min: number | null; max: number | null };
      repeatedTimelineRows: { rows: number; rate: number | null };
    };
  };
  normalization: NormalizationCounts | null;
  coverage: { floor: number; accountsReached: number; accountsTotal: number };
  authorShare: { topAuthorId: string | null; topHandle: string | null; topShare: number | null; topTen: NormalizationCounts["perAuthor"] };
  rejectionRates: { timeline: number | null; embedded: number | null };
  thresholds: { passed: boolean; checks: ThresholdCheck[] };
}

export async function buildReport(paths: RunPaths, manifest: Manifest, counts: NormalizationCounts | null): Promise<PilotReport> {
  const now = Date.now();
  const latencies: number[] = [];
  const rowsPerPage: number[] = [];
  let attempts = 0;
  let requestsWithMeta = 0;

  for (const account of manifest.acquisition.accounts) {
    if (account.userId === null) continue;
    for (let page = 1; page <= account.pagesCompleted; page += 1) {
      const meta = await readJson<PageMeta>(join(accountRawDirectory(paths, account.userId), pageMetaFileName(page)));
      latencies.push(meta.latencyMs);
      attempts += meta.attempts;
      requestsWithMeta += 1;
      const terminal = page === account.pagesCompleted && account.state === "completed";
      if (!terminal && meta.resultCount > 0) rowsPerPage.push(meta.resultCount);
    }
  }

  const totalRequests = manifest.acquisition.accounts.reduce((sum, account) => sum + account.requests, 0);
  const totalRetries = manifest.acquisition.accounts.reduce((sum, account) => sum + account.retries, 0);
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const timelineCandidates = counts?.candidates.timeline ?? 0;
  const embeddedCandidates = counts?.candidates.embedded ?? 0;
  const timelineRejectionRate = counts === null || timelineCandidates === 0 ? null : counts.rejected.timeline / timelineCandidates;
  const embeddedRejectionRate = counts === null || embeddedCandidates === 0 ? null : counts.rejected.embedded / embeddedCandidates;
  const repeatedRows = counts?.timelineRowsRepeatedWithinAccount ?? 0;
  const repeatedRate = counts === null || timelineCandidates === 0 ? null : repeatedRows / timelineCandidates;
  const retryRate = totalRequests === 0 ? null : totalRetries / totalRequests;
  const meanLatency = mean(latencies);
  const p95Latency = percentile(sortedLatencies, 0.95);
  const meanRows = mean(rowsPerPage);
  const pausedAccounts = manifest.acquisition.accounts.filter((account) => account.state === "paused");

  const checks: ThresholdCheck[] = [
    check("timeline rejection rate", timelineRejectionRate, "<= 1%", timelineRejectionRate === null ? null : timelineRejectionRate <= 0.01),
    check("embedded rejection rate (reported, not thresholded)", embeddedRejectionRate, "n/a", null),
    check("repeated timeline rows within account", repeatedRate, "<= 10%", repeatedRate === null ? null : repeatedRate <= 0.1),
    check("mean rows per non-terminal page", meanRows, "10..40", meanRows === null ? null : meanRows >= 10 && meanRows <= 40),
    check("mean latency ms", meanLatency, "500..3000", meanLatency === null ? null : meanLatency >= 500 && meanLatency <= 3_000),
    check("p95 latency ms", p95Latency, "<= 5000", p95Latency === null ? null : p95Latency <= 5_000),
    check("retry rate", retryRate, "< 5%", retryRate === null ? null : retryRate < 0.05),
    check("paused accounts", pausedAccounts.length, "0", pausedAccounts.length === 0),
    check("acquisition status", manifest.acquisition.status, "completed", manifest.acquisition.status === "completed"),
  ];

  const top = counts?.perAuthor[0] ?? null;
  return {
    version: 1,
    runId: manifest.runId,
    generatedAt: now,
    archiveNotice: manifest.archiveNotice,
    acquisition: {
      status: manifest.acquisition.status,
      cutoffAt: manifest.cutoffAt,
      accounts: manifest.acquisition.accounts.map((account) => ({
        handle: account.requestedHandle,
        resolvedHandle: account.resolvedHandle,
        userId: account.userId,
        cohort: account.cohort,
        state: account.state,
        stopReason: account.stopReason,
        pauseReason: account.pauseReason,
        pausedForMs: account.pausedAt === null ? null : now - account.pausedAt,
        abandonReason: account.abandonReason,
        pages: account.pagesCompleted,
        requests: account.requests,
        retries: account.retries,
        rowsReturned: account.rowsReturned,
        oldestAuthoredCreatedAt: account.oldestAuthoredCreatedAt,
        newestAuthoredCreatedAt: account.newestAuthoredCreatedAt,
      })),
      requests: {
        total: totalRequests,
        retries: totalRetries,
        retryRate,
        latencyMs: {
          mean: meanLatency,
          p50: percentile(sortedLatencies, 0.5),
          p95: p95Latency,
          max: sortedLatencies.length === 0 ? null : (sortedLatencies[sortedLatencies.length - 1] ?? null),
        },
        rowsPerPage: {
          pages: rowsPerPage.length,
          mean: meanRows,
          min: rowsPerPage.length === 0 ? null : Math.min(...rowsPerPage),
          max: rowsPerPage.length === 0 ? null : Math.max(...rowsPerPage),
        },
        repeatedTimelineRows: { rows: repeatedRows, rate: repeatedRate },
      },
    },
    normalization: counts,
    coverage: {
      floor: manifest.coverageFloor,
      accountsReached: counts?.perAccount.filter((account) => account.coverageFloorReached).length ?? 0,
      accountsTotal: manifest.acquisition.accounts.length,
    },
    authorShare: {
      topAuthorId: top?.authorId ?? null,
      topHandle: top?.handle ?? null,
      topShare: top?.share ?? null,
      topTen: counts?.perAuthor.slice(0, 10) ?? [],
    },
    rejectionRates: { timeline: timelineRejectionRate, embedded: embeddedRejectionRate },
    thresholds: { passed: checks.every((entry) => entry.passed !== false), checks },
  };
}

function check(name: string, value: number | string | null, bound: string, passed: boolean | null): ThresholdCheck {
  return { name, value: typeof value === "number" ? Math.round(value * 10_000) / 10_000 : value, bound, passed };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

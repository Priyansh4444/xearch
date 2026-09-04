import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FxTwitterError,
  type PilotClient,
  type ProfileResponse,
  type TimelineRequest,
  type TimelineFetchResult,
} from "../src/acquisition/fxtwitter.ts";
import type { PilotConfig } from "../src/config/pilot.ts";
import { acquire, createRun } from "../src/pilot/acquire.ts";
import { fileExists, readJson, runPaths, type RunPaths } from "../src/pilot/layout.ts";
import { abandonAccount, normalizeAndArchive, reopenAccount, verifyArchive } from "../src/pilot/lifecycle.ts";
import type { Checkpoint, Manifest } from "../src/pilot/manifest.ts";
import type { PilotReport } from "../src/pilot/report.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pilot acquisition", () => {
  it("resolves the pinned identity, retains every page with a sidecar, and completes on cursor exhaustion", async () => {
    const { dataDir, paths, config } = await freshRun([account("seed", "100")]);
    const client = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: { "100": [page([row("1", "100", NOW - DAY)], "c1"), page([row("2", "100", NOW - 2 * DAY)], null)] },
    });

    const manifest = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });

    expect(manifest.acquisition.status).toBe("completed");
    expect(manifest.acquisition.accounts[0]).toMatchObject({
      userId: "100",
      resolvedHandle: "Seed",
      state: "completed",
      stopReason: "cursor_exhausted",
      pagesCompleted: 2,
      requests: 3,
      rowsReturned: 2,
    });
    expect(client.timelineRequests.map((request) => [request.handle, request.cursor])).toEqual([
      ["id:100", null],
      ["id:100", "c1"],
    ]);
    expect(await fileExists(join(paths.raw, "100", "profile.json"))).toBe(true);
    expect(await fileExists(join(paths.raw, "100", "000002.json"))).toBe(true);
    const meta = await readJson<{ receivedAt: number; resultCount: number; outputCursor: string | null }>(
      join(paths.raw, "100", "000002.meta.json"),
    );
    expect(meta).toMatchObject({ receivedAt: expect.any(Number), resultCount: 1, outputCursor: null });
    expect(manifest.collector.configHash).toHaveLength(64);
    expect(manifest.cutoffAt).toBe(NOW - config.historyDays * DAY);
    void dataDir;
  });

  it("pauses on an identity mismatch and still collects the next account", async () => {
    const { paths, config } = await freshRun([account("squatted", "1"), account("real", "2")]);
    const client = fakeClient({
      profiles: { squatted: profile("999", "squatted"), real: profile("2", "real") },
      timelines: { "2": [page([row("20", "2", NOW - DAY)], null)] },
    });

    const manifest = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });

    expect(manifest.acquisition.status).toBe("in_progress");
    expect(manifest.acquisition.accounts[0]).toMatchObject({ state: "paused", pauseReason: "identity_mismatch", userId: null });
    expect(manifest.acquisition.accounts[1]).toMatchObject({ state: "completed", stopReason: "cursor_exhausted" });
    expect(await fileExists(join(paths.raw, "_unresolved", "squatted", "profile.json"))).toBe(true);
    expect(manifest.acceptance.passed).toBe(false);
  });

  it("stops at the history cutoff using seed-authored rows only, ignoring old repost originals", async () => {
    const { paths, config } = await freshRun([account("seed", "100")]);
    const cutoff = NOW - config.historyDays * DAY;
    const client = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: {
        "100": [
          page([row("r1", "900", cutoff - 400 * DAY, { repostedBy: "100" }), row("1", "100", NOW - DAY)], "c1"),
          page([row("r2", "900", cutoff - 500 * DAY, { repostedBy: "100" })], "c2"),
          page([row("2", "100", cutoff - DAY), row("3", "100", cutoff - 2 * DAY)], "c3"),
          page([row("4", "100", cutoff - 3 * DAY)], "c4"),
        ],
      },
    });

    const manifest = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });

    expect(manifest.acquisition.accounts[0]).toMatchObject({ state: "completed", stopReason: "history_cutoff", pagesCompleted: 3 });
    expect(client.timelineRequests).toHaveLength(3);
  });

  it("pauses on a stalled cursor instead of reporting exhaustion", async () => {
    const { paths, config } = await freshRun([account("seed", "100")]);
    const client = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: { "100": [page([row("1", "100", NOW - DAY)], "c1"), page([row("2", "100", NOW - 2 * DAY)], "c1")] },
    });

    const manifest = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });

    expect(manifest.acquisition.accounts[0]).toMatchObject({ state: "paused", pauseReason: "cursor_stalled", pagesCompleted: 2 });
    expect(manifest.acquisition.status).toBe("in_progress");
  });

  it("resumes after an interruption from the last completed page without re-resolving or re-requesting", async () => {
    const { paths, config } = await freshRun([account("seed", "100")]);
    const first = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: { "100": [page([row("1", "100", NOW - DAY)], "c1"), page([row("2", "100", NOW - 2 * DAY)], "c2")] },
    });
    const interrupted = await acquire({ paths, config, client: first, now: () => NOW, sleep: async () => undefined, maxRequests: 2 });
    expect(interrupted.acquisition.status).toBe("in_progress");
    expect(interrupted.acquisition.accounts[0]).toMatchObject({ state: "active", pagesCompleted: 1 });
    const checkpoint = await readJson<Checkpoint>(paths.checkpoint);
    expect(checkpoint.accounts[0]).toMatchObject({ nextPage: 2, nextCursor: "c1" });

    const second = fakeClient({
      profiles: {},
      timelines: { "100": [page([row("2", "100", NOW - 2 * DAY)], null)] },
    });
    const resumed = await acquire({ paths, config, client: second, now: () => NOW, sleep: async () => undefined });

    expect(second.profileRequests).toEqual([]);
    expect(second.timelineRequests.map((request) => request.cursor)).toEqual(["c1"]);
    expect(resumed.acquisition.accounts[0]).toMatchObject({ state: "completed", pagesCompleted: 2, requests: 3 });
  });

  it("pauses an account on a provider failure, keeps the raw error, and retries on the next invocation", async () => {
    const { paths, config } = await freshRun([account("seed", "100"), account("next", "200")]);
    const first = fakeClient({
      profiles: { seed: profile("100", "Seed"), next: profile("200", "Next") },
      timelines: {
        "100": [new FxTwitterError("FxTwitter returned HTTP 500", 500, "boom")],
        "200": [page([row("20", "200", NOW - DAY)], null)],
      },
    });
    const paused = await acquire({ paths, config, client: first, now: () => NOW, sleep: async () => undefined });
    expect(paused.acquisition.accounts[0]).toMatchObject({ state: "paused", pauseReason: "provider_error", pagesCompleted: 0 });
    expect(paused.acquisition.accounts[1]).toMatchObject({ state: "completed" });
    expect(await fileExists(join(paths.raw, "100", "000001.error.json"))).toBe(true);

    const second = fakeClient({ profiles: {}, timelines: { "100": [page([row("1", "100", NOW - DAY)], null)] } });
    const recovered = await acquire({ paths, config, client: second, now: () => NOW, sleep: async () => undefined });
    expect(recovered.acquisition.status).toBe("completed");
    expect(recovered.acquisition.accounts[0]).toMatchObject({ state: "completed", pauseReason: null });
  });

  it("continues past a transient empty page and exhausts only after three empties in a row", async () => {
    const { paths, config } = await freshRun([account("seed", "100")]);
    const client = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: {
        "100": [
          page([row("1", "100", NOW - DAY)], "c1"),
          page([], "c2"),
          page([row("2", "100", NOW - 2 * DAY)], "c3"),
          page([], "c4"),
          page([], "c5"),
          page([], "c6"),
          page([row("never", "100", NOW - 3 * DAY)], "c7"),
        ],
      },
    });

    const manifest = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });

    expect(client.timelineRequests.map((request) => request.cursor)).toEqual([null, "c1", "c2", "c3", "c4", "c5"]);
    expect(manifest.acquisition.accounts[0]).toMatchObject({ state: "completed", stopReason: "cursor_exhausted", pagesCompleted: 6, rowsReturned: 2 });
  });

  it("reopens a cursor-exhausted account from the cursor that produced its last page", async () => {
    const { dataDir, paths, config } = await freshRun([account("seed", "100")]);
    const first = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: { "100": [page([row("1", "100", NOW - DAY)], "c1"), page([], "c2"), page([], "c3"), page([], "c4")] },
    });
    const exhausted = await acquire({ paths, config, client: first, now: () => NOW, sleep: async () => undefined });
    expect(exhausted.acquisition.accounts[0]).toMatchObject({ state: "completed", stopReason: "cursor_exhausted", pagesCompleted: 4 });

    await expect(reopenAccount({ dataDir, paths, config, now: () => NOW }, "seed", "")).rejects.toThrow(/reason/);
    const reopened = await reopenAccount({ dataDir, paths, config, now: () => NOW }, "seed", "provider transient");
    expect(reopened.acquisition.status).toBe("in_progress");

    // The provider replays the same page (same output cursor c4) before yielding rows:
    // that replay must not be read as a stall.
    const second = fakeClient({
      profiles: {},
      timelines: { "100": [page([], "c4"), page([row("2", "100", NOW - 2 * DAY)], null)] },
    });
    const resumed = await acquire({ paths, config, client: second, now: () => NOW, sleep: async () => undefined });
    expect(second.timelineRequests.map((request) => request.cursor)).toEqual(["c3", "c4"]);
    expect(resumed.acquisition.accounts[0]).toMatchObject({ state: "completed", pagesCompleted: 6, rowsReturned: 2 });
  });

  it("reopens a cursor_stalled account too", async () => {
    const { dataDir, paths, config } = await freshRun([account("seed", "100")]);
    const client = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: { "100": [page([row("1", "100", NOW - DAY)], "c1"), page([row("2", "100", NOW - 2 * DAY)], "c1")] },
    });
    const stalled = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });
    expect(stalled.acquisition.accounts[0]).toMatchObject({ state: "paused", pauseReason: "cursor_stalled" });
    const reopened = await reopenAccount({ dataDir, paths, config, now: () => NOW }, "seed", "provider replayed a cursor");
    expect(reopened.acquisition.accounts[0]).toMatchObject({ state: "active", pauseReason: null });
  });

  it("never reopens an account that completed through the history cutoff", async () => {
    const { dataDir, paths, config } = await freshRun([account("seed", "100")]);
    const cutoff = NOW - config.historyDays * DAY;
    const client = fakeClient({ profiles: { seed: profile("100", "Seed") }, timelines: { "100": [page([row("1", "100", cutoff - DAY)], "c1")] } });
    const manifest = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });
    expect(manifest.acquisition.accounts[0]).toMatchObject({ state: "completed", stopReason: "history_cutoff" });
    await expect(reopenAccount({ dataDir, paths, config, now: () => NOW }, "seed", "why not")).rejects.toThrow(/only cursor_exhausted/);
  });

  it("treats 204 as exhaustion without counting a page", async () => {
    const { paths, config } = await freshRun([account("seed", "100")]);
    const client = fakeClient({ profiles: { seed: profile("100", "Seed") }, timelines: { "100": [noContent()] } });
    const manifest = await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });
    expect(manifest.acquisition.accounts[0]).toMatchObject({ state: "completed", stopReason: "cursor_exhausted", pagesCompleted: 0 });
  });
});

describe("pilot lifecycle", () => {
  it("normalizes, validates, archives with hashes, and verifies byte for byte", async () => {
    const { dataDir, paths, config } = await freshRun([account("seed", "100")]);
    const client = fakeClient({
      profiles: { seed: profile("100", "Seed") },
      timelines: {
        "100": [
          page([row("1", "100", NOW - DAY), row("q", "100", NOW - DAY, { quotes: row("9", "300", NOW - 3 * DAY) })], "c1"),
          page([row("1", "100", NOW - DAY, { likes: 50 }), row("2", "100", NOW - 2 * DAY)], null, NOW + 1_000),
        ],
      },
    });
    await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });

    const result = await normalizeAndArchive({ dataDir, paths, config, now: () => NOW });

    expect(await fileExists(paths.root)).toBe(false);
    expect(result.archivedPaths.root).toBe(runPaths(dataDir, "old", "test-run").root);
    expect(result.counts.accepted.total).toBe(4);
    expect(result.counts.duplicates).toBe(1);
    expect(result.counts.metricsRefreshed).toBe(1);
    expect(result.manifest.acceptance.passed).toBe(true);
    expect(result.manifest.archive?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["checkpoint.json", "config.json", "ingress/records.jsonl", "raw/100/000001.json", "raw/100/000001.meta.json", "report.json"]),
    );
    const ingress = await readFile(result.archivedPaths.ingress, "utf8");
    expect(ingress.split("\n")[0]).toContain('"kind":"author"');
    const report = await readJson<PilotReport>(result.archivedPaths.report);
    expect(report.acquisition.requests.total).toBe(3);
    expect(report.thresholds.checks.find((check) => check.name === "paused accounts")?.passed).toBe(true);
    expect(report.authorShare.topHandle).toBe("seed");

    const scratch = await temporaryDirectory();
    const verification = await verifyArchive(result.archivedPaths, scratch, config);
    expect(verification).toMatchObject({ passed: true, hashMismatches: [], outputsDiffering: [] });
    expect(verification.hashesChecked).toBeGreaterThan(5);
  });

  it("refuses to normalize an in-progress run, and archives a partial run with acceptance false after an explicit abandon", async () => {
    const { dataDir, paths, config } = await freshRun([account("broken", "1"), account("fine", "2")]);
    const client = fakeClient({
      profiles: { broken: profile("42", "someone_else"), fine: profile("2", "fine") },
      timelines: { "2": [page([row("20", "2", NOW - DAY)], null)] },
    });
    await acquire({ paths, config, client, now: () => NOW, sleep: async () => undefined });
    await expect(normalizeAndArchive({ dataDir, paths, config, now: () => NOW })).rejects.toThrow(/in_progress/);

    await expect(abandonAccount({ dataDir, paths, config, now: () => NOW }, "broken", "   ")).rejects.toThrow(/reason/);
    const manifest = await abandonAccount({ dataDir, paths, config, now: () => NOW }, "broken", "handle squatted; needs a config fix");
    expect(manifest.acquisition.status).toBe("partial");

    const result = await normalizeAndArchive({ dataDir, paths, config, now: () => NOW });
    expect(result.manifest.acquisition.status).toBe("partial");
    expect(result.manifest.acceptance.passed).toBe(false);
    expect(result.manifest.acceptance.reasons.join(" ")).toContain("broken abandoned: handle squatted");
    expect(result.manifest.archiveNotice).toMatch(/not successful/);
    const archived = await readJson<Manifest>(result.archivedPaths.manifest);
    expect(archived.archive?.files.some((file) => file.path === "raw/_unresolved/broken/profile.json")).toBe(true);
  });
});

// ---------- helpers ----------

async function freshRun(accounts: PilotConfig["accounts"]): Promise<{ dataDir: string; paths: RunPaths; config: PilotConfig }> {
  const dataDir = await temporaryDirectory();
  const config: PilotConfig = {
    version: 2,
    source: "fxtwitter",
    apiBaseUrl: "https://api.fxtwitter.com",
    apiVersion: "2",
    specificationUrl: "https://api.fxtwitter.com/2/openapi.json",
    historyDays: 183,
    withReplies: true,
    requestedPageSize: 100,
    delayMs: 0,
    coverageFloor: 2,
    selectedOn: "2026-09-03",
    accounts,
  };
  const paths = runPaths(dataDir, "runs", "test-run");
  await createRun(paths, config, "test-run", NOW);
  return { dataDir, paths, config };
}

function account(handle: string, expectedUserId: string): PilotConfig["accounts"][number] {
  return { handle, expectedUserId, cohort: "core" };
}

interface FakeScript {
  profiles: Record<string, ProfileResponse>;
  timelines: Record<string, (TimelineFetchResult | Error)[]>;
}

function fakeClient(script: FakeScript): PilotClient & { profileRequests: string[]; timelineRequests: TimelineRequest[] } {
  const profileRequests: string[] = [];
  const timelineRequests: TimelineRequest[] = [];
  return {
    profileRequests,
    timelineRequests,
    async fetchProfile(handle) {
      profileRequests.push(handle);
      const response = script.profiles[handle];
      if (response === undefined) throw new Error(`unexpected profile request for ${handle}`);
      return response;
    },
    async fetchTimelinePage(request) {
      timelineRequests.push(request);
      const userId = request.handle.replace(/^id:/, "");
      const next = script.timelines[userId]?.shift();
      if (next === undefined) throw new Error(`unexpected timeline request for ${request.handle}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function profile(id: string, screenName: string): ProfileResponse {
  const raw = { code: 200, message: "OK", user: { id, screen_name: screenName, name: screenName, protected: false } };
  return { httpStatus: 200, latencyMs: 20, attempts: 1, receivedAt: NOW, raw, profile: { id, screenName, name: screenName, protected: false } };
}

function page(results: unknown[], bottom: string | null, receivedAt = NOW): TimelineFetchResult {
  const raw = { code: 200, results, cursor: { top: "t", bottom } };
  return { httpStatus: 200, latencyMs: 1_000, attempts: 1, receivedAt, raw, page: raw };
}

function noContent(): TimelineFetchResult {
  return { httpStatus: 204, latencyMs: 10, attempts: 1, receivedAt: NOW, raw: null, page: null };
}

function row(
  id: string,
  authorId: string,
  createdAtMs: number,
  options: { repostedBy?: string; quotes?: Record<string, unknown>; likes?: number } = {},
): Record<string, unknown> {
  return {
    type: "status",
    id,
    text: `post ${id}`,
    created_timestamp: Math.floor(createdAtMs / 1_000),
    likes: options.likes ?? 1,
    reposts: 0,
    quotes: 0,
    replies: 0,
    lang: "en",
    replying_to: null,
    quote: options.quotes ?? null,
    reposted_by: options.repostedBy ? { id: options.repostedBy, screen_name: "reposter", name: "Reposter" } : null,
    media: null,
    author: {
      id: authorId,
      screen_name: authorId === "100" ? "Seed" : `user${authorId}`,
      name: `User ${authorId}`,
      followers: 10,
      following: 5,
      joined: "Sat Jan 01 00:00:00 +0000 2011",
      verification: { verified: false },
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xearch-pilot-"));
  temporaryDirectories.push(directory);
  return directory;
}

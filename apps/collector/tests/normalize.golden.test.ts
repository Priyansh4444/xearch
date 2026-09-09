import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fxtwitter/pages.json" with { type: "json" };
import { mapStatus } from "../src/normalization/mapping.ts";
import {
  normalizePages,
  unknownRejectionCodes,
  type NormalizationResult,
  type NormalizeAccount,
  type RawPageInput,
} from "../src/normalization/normalize.ts";
import type { AuthorId, Handle } from "../src/contracts/ids.ts";

const EXPECTED_DIR = fileURLToPath(new URL("./fixtures/fxtwitter/expected/", import.meta.url));

function accounts(): NormalizeAccount[] {
  return fixture.accounts.map((account) => ({
    userId: account.userId as AuthorId,
    handle: account.handle as Handle,
  }));
}

function pages(): RawPageInput[] {
  return fixture.pages.map((page) => ({
    ...page,
    accountUserId: page.accountUserId as AuthorId,
    rawFile: `raw/${page.accountUserId}/${String(page.page).padStart(6, "0")}.json`,
  }));
}

function run(): NormalizationResult {
  return normalizePages(pages(), {
    cutoffAt: fixture.cutoffAt,
    coverageFloor: fixture.coverageFloor,
    accounts: accounts(),
  });
}

describe("normalization golden fixture", () => {
  const result = run();

  it.each([
    { name: "ingress.jsonl", actual: result.ingress },
    { name: "rejections.jsonl", actual: result.rejections },
    { name: "duplicates.jsonl", actual: result.duplicates },
    { name: "skips.jsonl", actual: result.skips },
  ])("matches committed $name byte for byte", async ({ name, actual }) => {
    const expected = await readFile(join(EXPECTED_DIR, name), "utf8");
    expect(actual).toBe(expected);
  });

  it("matches committed counts", async () => {
    const counts = JSON.parse(await readFile(join(EXPECTED_DIR, "counts.json"), "utf8")) as unknown;
    expect(result.counts).toEqual(counts);
  });

  // The fixture has 3 pages, so all 6 input orders are enumerable: this is
  // exhaustive, not sampled — every order must yield byte-identical output.
  it.each([
    { order: [0, 1, 2] },
    { order: [0, 2, 1] },
    { order: [1, 0, 2] },
    { order: [1, 2, 0] },
    { order: [2, 0, 1] },
    { order: [2, 1, 0] },
  ])("is byte-identical under page order $order (exhaustive: 3 pages)", ({ order }) => {
    const input = pages();
    const shuffled = normalizePages(
      order.map((i) => input[i]!),
      { cutoffAt: fixture.cutoffAt, coverageFloor: fixture.coverageFloor, accounts: accounts() },
    );
    const expected = run();
    expect(shuffled.ingress).toBe(expected.ingress);
    expect(shuffled.rejections).toBe(expected.rejections);
    expect(shuffled.duplicates).toBe(expected.duplicates);
    expect(shuffled.skips).toBe(expected.skips);
    expect(shuffled.counts).toEqual(expected.counts);
  });

  it("emits every author before the first tweet that references it and never repeats an author", () => {
    const lines = run()
      .ingress.trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; id: string; authorId?: string });
    const seenAuthors = new Set<string>();
    for (const line of lines) {
      if (line.kind === "author") {
        expect(seenAuthors.has(line.id)).toBe(false);
        seenAuthors.add(line.id);
      } else {
        expect(seenAuthors.has(line.authorId as string)).toBe(true);
      }
    }
  });

  it("uses only documented rejection codes", () => {
    expect(unknownRejectionCodes(run().counts)).toEqual([]);
  });
});

describe("provider mapping", () => {
  const context = {
    accountUserId: "1" as AuthorId,
    page: 1,
    rawFile: "raw/1/000001.json",
    receivedAt: 1_700_000_000_000,
    origin: "timeline" as const,
    index: 0,
    parentId: null,
  };

  it("never invents a metric or an author field", () => {
    const status = fixture.pages[0]?.results[6];
    const mapped = mapStatus(status, context);
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.rejection.reasons).toEqual(["empty_text"]);

    const thin = mapStatus(fixture.pages[0]?.results[7], context);
    expect(thin.ok).toBe(false);
    if (!thin.ok)
      expect(thin.rejection.reasons).toEqual([
        "missing_author_counts",
        "missing_author_verification",
      ]);
  });

  it.each([1_700_000_000_000, 1_700_000_000_001, 0])(
    "sets metricsAt from the page sidecar (%i) and leaves retweetOfTweetId null",
    (receivedAt) => {
      const mapped = mapStatus(fixture.pages[0]?.results[0], { ...context, receivedAt });
      expect(mapped.ok).toBe(true);
      if (mapped.ok) {
        expect(mapped.tweet.metricsAt).toBe(receivedAt);
        expect(mapped.tweet.retweetOfTweetId).toBeNull();
        expect(mapped.tweet.createdAt).toBe(1_700_090_000_000);
        expect(mapped.tweet.entities).toEqual({
          hashtags: ["tag"],
          mentions: [],
          urls: ["https://example.com/page"],
        });
      }
    },
  );

  it("keeps a tombstone quote id as a dangling edge without creating a candidate", () => {
    const mapped = mapStatus(fixture.pages[0]?.results[3], context);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.tweet.quotedTweetId).toBe("9002");
      expect(mapped.quoteTombstone).toBe(true);
      expect(mapped.embedded).toEqual([]);
    }
  });

  it("maps a repost row to its original author and flags it as reposted", () => {
    const mapped = mapStatus(fixture.pages[0]?.results[4], {
      ...context,
      accountUserId: "100" as AuthorId,
    });
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.reposted).toBe(true);
      expect(mapped.authoredByAccount).toBe(false);
      expect(mapped.tweet.authorId).toBe("400");
    }
  });
});

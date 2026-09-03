import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fxtwitter/pages.json" with { type: "json" };
import { mapStatus } from "../src/normalization/mapping.ts";
import { normalizePages, unknownRejectionCodes } from "../src/normalization/normalize.ts";

const EXPECTED_DIR = fileURLToPath(new URL("./fixtures/fxtwitter/expected/", import.meta.url));

function run() {
  return normalizePages(
    fixture.pages.map((page) => ({ ...page, rawFile: `raw/${page.accountUserId}/${String(page.page).padStart(6, "0")}.json` })),
    { cutoffAt: fixture.cutoffAt, coverageFloor: fixture.coverageFloor, accounts: fixture.accounts },
  );
}

describe("normalization golden fixture", () => {
  it("matches the committed ingress, rejection, duplicate, and skip output byte for byte", async () => {
    const result = run();
    for (const [name, actual] of [
      ["ingress.jsonl", result.ingress],
      ["rejections.jsonl", result.rejections],
      ["duplicates.jsonl", result.duplicates],
      ["skips.jsonl", result.skips],
    ] as const) {
      const expected = await readFile(join(EXPECTED_DIR, name), "utf8");
      expect(actual, name).toBe(expected);
    }
    const counts = JSON.parse(await readFile(join(EXPECTED_DIR, "counts.json"), "utf8")) as unknown;
    expect(result.counts).toEqual(counts);
  });

  it("is deterministic regardless of page input order", () => {
    const shuffled = normalizePages(
      [...fixture.pages].reverse().map((page) => ({ ...page, rawFile: `raw/${page.accountUserId}/${String(page.page).padStart(6, "0")}.json` })),
      { cutoffAt: fixture.cutoffAt, coverageFloor: fixture.coverageFloor, accounts: fixture.accounts },
    );
    expect(shuffled.ingress).toBe(run().ingress);
    expect(shuffled.rejections).toBe(run().rejections);
  });

  it("emits every author before the first tweet that references it and never repeats an author", () => {
    const lines = run().ingress.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; id: string; authorId?: string });
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
    accountUserId: "1",
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
    if (!thin.ok) expect(thin.rejection.reasons).toEqual(["missing_author_counts", "missing_author_verification"]);
  });

  it("sets metricsAt from the page sidecar and leaves retweetOfTweetId null", () => {
    const mapped = mapStatus(fixture.pages[0]?.results[0], context);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.tweet.metricsAt).toBe(context.receivedAt);
      expect(mapped.tweet.retweetOfTweetId).toBeNull();
      expect(mapped.tweet.createdAt).toBe(1_700_090_000_000);
      expect(mapped.tweet.entities).toEqual({ hashtags: ["tag"], mentions: [], urls: ["https://example.com/page"] });
    }
  });

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
    const mapped = mapStatus(fixture.pages[0]?.results[4], { ...context, accountUserId: "100" });
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.reposted).toBe(true);
      expect(mapped.authoredByAccount).toBe(false);
      expect(mapped.tweet.authorId).toBe("400");
    }
  });
});

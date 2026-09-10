import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { AuthorId } from "../convex/contracts/ids";
import { tierA, tierB, type TierBDeps } from "../convex/engine/parse";

interface Expected {
  must: string[];
  should?: string[];
  aspects?: string[];
  intent: string;
  authorId: string | null;
}

interface IntentCase {
  raw: string;
  expect: Expected;
  note: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../shared/fixtures/search-intent-cases.json", import.meta.url), "utf8"),
) as { cases: IntentCase[] };

const deps: TierBDeps = {
  async resolveEntity(ngram) {
    if (ngram.join("") === "convex") return { authorId: "convex-author" as AuthorId };
    if (ngram.join("") === "theo") return { authorId: "theo-author" as AuthorId };
    return null;
  },
  async resolveHandle(handle) {
    if (handle === "convex") return { authorId: "convex-author" as AuthorId };
    if (handle === "theo") return { authorId: "theo-author" as AuthorId };
    return null;
  },
  async dfOf() {
    return null;
  },
  now: () => Date.UTC(2026, 8, 9),
};

describe("production-sample-derived intent cases", () => {
  for (const item of fixture.cases) {
    test(`${item.raw}: ${item.note}`, async () => {
      const parsed = await tierB(tierA(item.raw), deps);
      expect(parsed.xq.must).toEqual(item.expect.must);
      expect(parsed.xq.should).toEqual(item.expect.should ?? []);
      expect(parsed.xq.aspects).toEqual(item.expect.aspects ?? []);
      expect(parsed.xq.intent).toBe(item.expect.intent);
      expect(parsed.xq.filters.authorId).toBe(item.expect.authorId);
    });
  }
});

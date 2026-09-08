// Parser golden test (contract #5): every Tier A + B fixture row must parse to the
// expected XQuery. Tier C rows are skipped — they are the LLM layer's spec, not
// Tier A/B's. Deps are fakes that mirror the production rules in convex/search.ts:
// handle-exact entity resolution with a common-word df floor.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { mapAspects, tierA, tierB, type TierBDeps } from "../convex/engine/parse";
import { COMMON_DF_FLOOR } from "../convex/search";

const NOW = Date.UTC(2026, 8, 7, 12); // fixed clock: 2026-09-07T12:00Z
const DAY = 86_400_000;
const AUTHORS: Record<string, string> = {
  jamwt: "id-jamwt",
  elonmusk: "id-elonmusk",
  karpathy: "id-karpathy",
  jack: "id-jack", // present so the df floor — not absence — is what blocks linking
};

const DF: Record<string, number> = {
  jack: 9000, // common word: must never entity-link (RISKS P1)
  apple: 5000,
};

test("repeated weak triggers do not count as content", () => {
  expect(mapAspects(["cheap", "cheap", "expensive"], "")).not.toContain("~price");
  expect(mapAspects(["cheap", "laptop"], "")).toContain("~price");
});

test("invalid absolute dates remain visible instead of rolling over", async () => {
  const { xq, trace } = await tierB(tierA("since:2026-13-45 linux"), deps);
  expect(xq.filters.since).toBeNull();
  expect(trace.leftover).toContain("since:2026-13-45");
});

const deps: TierBDeps = {
  async resolveEntity(ngram) {
    const joined = ngram.join("");
    const df = DF[joined];
    if (df !== undefined && df >= COMMON_DF_FLOOR) return null;
    const authorId = AUTHORS[joined];
    return authorId === undefined ? null : { authorId };
  },
  async resolveHandle(handle) {
    const authorId = AUTHORS[handle];
    return authorId === undefined ? null : { authorId };
  },
  async dfOf(term) {
    return DF[term] ?? null;
  },
  now: () => NOW,
};

interface GoldenRow {
  raw: string;
  tier: "A" | "B" | "C";
  expect: {
    must?: string[];
    mustIncludes?: string[];
    should?: string[];
    phrases?: string[][];
    exclude?: string[];
    aspects?: string[];
    media?: string;
    sort?: string;
    intent?: string;
    authorHandle?: string | null;
    sinceRelativeDays?: number;
    hasDateWindow?: boolean;
    filtersUnchanged?: boolean;
  };
  note: string;
}

const rows: GoldenRow[] = readFileSync(
  join(__dirname, "../shared/fixtures/parser-golden.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as GoldenRow);

describe("parser golden fixture (tiers A+B)", () => {
  for (const row of rows) {
    if (row.tier === "C") continue;
    test(`${row.raw} — ${row.note}`, async () => {
      const { xq } = await tierB(tierA(row.raw), deps);
      const e = row.expect;
      if (e.must !== undefined) expect(xq.must).toEqual(e.must);
      if (e.mustIncludes !== undefined) {
        for (const t of e.mustIncludes) expect(xq.must).toContain(t);
      }
      if (e.should !== undefined) expect(xq.should).toEqual(e.should);
      if (e.phrases !== undefined) expect(xq.phrases).toEqual(e.phrases);
      if (e.exclude !== undefined) expect(xq.exclude).toEqual(e.exclude);
      if (e.aspects !== undefined) expect(xq.aspects).toEqual(e.aspects);
      if (e.media !== undefined) expect(xq.filters.media).toBe(e.media);
      if (e.sort !== undefined) expect(xq.sort).toBe(e.sort);
      if (e.intent !== undefined) expect(xq.intent).toBe(e.intent);
      if (e.authorHandle !== undefined) {
        expect(xq.filters.authorId).toBe(
          e.authorHandle === null ? null : AUTHORS[e.authorHandle],
        );
      }
      if (e.sinceRelativeDays !== undefined) {
        expect(xq.filters.since).toBe(NOW - e.sinceRelativeDays * DAY);
      }
      if (e.hasDateWindow !== undefined) {
        expect(xq.filters.since !== null || xq.filters.until !== null).toBe(
          e.hasDateWindow,
        );
      }
      if (e.filtersUnchanged === true) {
        expect(xq.filters).toEqual({
          authorId: null,
          since: null,
          until: null,
          media: null,
          minLikes: null,
          lang: null,
        });
      }
    });
  }
});

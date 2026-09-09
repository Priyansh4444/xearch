// Parser golden test (contract #5): every Tier A + B fixture row must parse to the
// expected XQuery. Tier C rows are skipped — they are the LLM layer's spec, not
// Tier A/B's. Deps are fakes that mirror the production rules in convex/search.ts:
// handle-exact entity resolution with a common-word df floor.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, it } from "vitest";
import { mapAspects, tierA, tierB, type TierBDeps } from "../convex/engine/parse";
import type { AuthorId, Term } from "../convex/contracts/ids";
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

it.each(["cheap", "expensive", "cost", "costs", "afford", "free", "budget", "pricey"])(
  "weak ~price trigger %j needs a content co-occurrence (either order)",
  async (weak) => {
    const w = weak as Term;
    expect(mapAspects([w] as Term[], "")).not.toContain("~price");
    expect(mapAspects([w, w] as Term[], "")).not.toContain("~price");
    for (const order of [
      [w, "laptop" as Term],
      ["laptop" as Term, w],
    ]) {
      expect(mapAspects(order, "")).toContain("~price");
    }
  },
);

it.each([
  { aspect: "~price", strong: ["pricing"] },
  { aspect: "~perf", strong: ["latency"] },
  { aspect: "~quality", strong: ["build", "quality"] },
  { aspect: "~spec", strong: ["battery", "life"] },
  { aspect: "~release", strong: ["release", "date"] },
  { aspect: "~drama", strong: ["main", "character"] },
  { aspect: "~compare", strong: ["better", "than"] },
  { aspect: "~howto", strong: ["tutorial"] },
  { aspect: "~opinion", strong: ["hot", "take"] },
  { aspect: "~security", strong: ["data", "breach"] },
])("strong pattern $strong fires $aspect with no co-occurrence needed", ({ aspect, strong }) => {
  expect(mapAspects(strong as Term[], "")).toContain(aspect);
});

it.each(["$5", "price is $100", "costs $0"])(
  "dollar-digit raw text %j is a ~price signal",
  (raw) => {
    expect(mapAspects(["laptop"] as Term[], raw)).toContain("~price");
  },
);

it.each([
  "since:2026-13-45",
  "since:2026-00-10",
  "since:2026-01-32",
  "since:2026-02-30",
  "since:2023-02-29",
  "since:2026-04-31",
  "until:2026-13-01",
  "until:1999-02-29",
])("invalid absolute date %j stays visible with no filter set", async (op) => {
  const { xq, trace } = await tierB(tierA(`${op} linux`), deps);
  expect(xq.filters.since).toBeNull();
  expect(xq.filters.until).toBeNull();
  expect(trace.leftover).toContain(op);
});

it.each([
  { op: "since:2026-02-28", slot: "since", expected: Date.UTC(2026, 1, 28) },
  { op: "since:2024-02-29", slot: "since", expected: Date.UTC(2024, 1, 29) },
  { op: "until:2026-12-31", slot: "until", expected: Date.UTC(2026, 11, 31) },
  { op: "since:2026-01-01", slot: "since", expected: Date.UTC(2026, 0, 1) },
])("valid absolute date $op resolves to epoch ms", async ({ op, slot, expected }) => {
  const { xq, trace } = await tierB(tierA(`${op} linux`), deps);
  expect(xq.filters[slot as "since" | "until"]).toBe(expected);
  expect(trace.leftover).not.toContain(op);
});

it.each([
  { op: "since:7d", slot: "since", expected: NOW - 7 * DAY },
  { op: "since:24h", slot: "since", expected: NOW - 24 * 3_600_000 },
  { op: "since:2w", slot: "since", expected: NOW - 14 * DAY },
  { op: "until:1d", slot: "until", expected: NOW - DAY },
])("relative date $op resolves against the fixed clock", async ({ op, slot, expected }) => {
  const { xq } = await tierB(tierA(`${op} linux`), deps);
  expect(xq.filters[slot as "since" | "until"]).toBe(expected);
});

describe("parser strong permutations", () => {
  function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i++) {
      const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([xs[i]!, ...tail]);
    }
    return out;
  }

  it("operator order never changes the parse (all 24 orders)", async () => {
    const fragments = ["from:jamwt", "since:2026-01-01", "sort:latest", "-iphone"];
    const baseline = await tierB(tierA(fragments.join(" ")), deps);
    for (const order of permutations(fragments)) {
      const { xq, trace } = await tierB(tierA(order.join(" ")), deps);
      expect(xq.must).toEqual(baseline.xq.must);
      expect(xq.exclude).toEqual(baseline.xq.exclude);
      expect(xq.filters).toEqual(baseline.xq.filters);
      expect(xq.sort).toBe(baseline.xq.sort);
      expect(trace.leftover).toEqual(baseline.trace.leftover);
    }
  });

  it.each(["from", "FROM", "From", "fRoM"])("operator name %j resolves the handle", async (op) => {
    const { xq, trace } = await tierB(tierA(`${op}:jamwt linux`), deps);
    expect(xq.filters.authorId).toBe(AUTHORS["jamwt"]);
    expect(xq.must).toEqual(["linux"]);
    expect(trace.leftover).not.toContain(`${op}:jamwt`);
  });

  it.each(["latest", "LATEST", "Latest"])("sort value %j: only lowercase binds", async (value) => {
    const { xq } = await tierB(tierA(`sort:${value} linux`), deps);
    if (value === "latest") {
      expect(xq.sort).toBe("latest");
    } else {
      // Unknown operator VALUE stays literal text: the op is rejected, the
      // tokenizer then splits `sort:LATEST` into plain terms.
      expect(xq.sort).toBe("top");
      expect(xq.must).toContain("sort");
      expect(xq.must).toContain(value.toLowerCase());
    }
  });

  it.each([
    { raw: "apple box", must: ["apple", "box"] },
    { raw: "apple  box", must: ["apple", "box"] },
    { raw: "  apple box  ", must: ["apple", "box"] },
    { raw: "apple\tbox", must: ["apple", "box"] },
    { raw: "apple   box   linux", must: ["apple", "box", "linux"] },
  ])("whitespace shape %j parses to the same must terms", async ({ raw, must }) => {
    const { xq } = await tierB(tierA(raw), deps);
    expect(xq.must).toEqual(must);
  });
});

const deps: TierBDeps = {
  async resolveEntity(ngram) {
    const joined = ngram.join("");
    const df = DF[joined];
    if (df !== undefined && df >= COMMON_DF_FLOOR) return null;
    const authorId = AUTHORS[joined];
    return authorId === undefined ? null : { authorId: authorId as AuthorId };
  },
  async resolveHandle(handle) {
    const authorId = AUTHORS[handle];
    return authorId === undefined ? null : { authorId: authorId as AuthorId };
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
        expect(xq.filters.authorId).toBe(e.authorHandle === null ? null : AUTHORS[e.authorHandle]);
      }
      if (e.sinceRelativeDays !== undefined) {
        expect(xq.filters.since).toBe(NOW - e.sinceRelativeDays * DAY);
      }
      if (e.hasDateWindow !== undefined) {
        expect(xq.filters.since !== null || xq.filters.until !== null).toBe(e.hasDateWindow);
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

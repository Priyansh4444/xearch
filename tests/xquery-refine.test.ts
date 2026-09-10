// parseXQueryJson is the trust boundary for queryCache rows (Tier C output and
// older cache versions); mergeRefinement is the may-not-override rule (PARSER §2).

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  emptyXQuery,
  Intent,
  isEpochMs,
  mergeRefinement,
  normalizeRaw,
  parseXQueryJson,
  SortOrder,
  type XQuery,
  type XQueryFilters,
} from "../convex/engine/xquery";
import type { AuthorId, Term } from "../convex/contracts/ids";

const t = (s: string): Term => s as Term;

type PartialXQuery = Omit<Partial<XQuery>, "filters"> & { filters?: Partial<XQueryFilters> };

function xq(overrides: PartialXQuery = {}): XQuery {
  const base = emptyXQuery();
  return { ...base, ...overrides, filters: { ...base.filters, ...overrides.filters } };
}

describe("parseXQueryJson", () => {
  it("round-trips canonical JSON for a fully-populated query", () => {
    const full = xq({
      intent: Intent.PersonTopic,
      must: [t("linux"), t("box")],
      should: [t("cheap")],
      phrases: [[t("server"), t("components")]],
      exclude: [t("iphone")],
      aspects: [t("~price")],
      filters: {
        authorId: "44196397" as AuthorId,
        since: Date.UTC(2026, 0, 1),
        until: Date.UTC(2026, 6, 1),
        media: "image",
        minLikes: 10,
        lang: "en",
      },
      sort: SortOrder.Latest,
    });
    const parsed = parseXQueryJson(canonicalJson(full));
    expect(parsed).not.toBeNull();
    expect(canonicalJson(parsed!)).toBe(canonicalJson(full));
  });

  it("round-trips the empty query", () => {
    expect(parseXQueryJson(canonicalJson(emptyXQuery()))).toEqual(emptyXQuery());
  });

  it.each([
    ["not JSON", "nope{"],
    ["not an object", "[1]"],
    ["wrong version", canonicalJson(xq()).replace('"v":1', '"v":2')],
    ["unknown intent", JSON.stringify({ ...xq(), intent: "vibes" })],
    ["unknown sort", JSON.stringify({ ...xq(), sort: "hot" })],
    ["non-array must", JSON.stringify({ ...xq(), must: "linux" })],
    ["uppercase term", JSON.stringify({ ...xq(), must: ["Linux"] })],
    ["term with whitespace", JSON.stringify({ ...xq(), should: ["two words"] })],
    ["unknown aspect", JSON.stringify({ ...xq(), aspects: ["~vibes"] })],
    ["empty phrase", JSON.stringify({ ...xq(), phrases: [[]] })],
    [
      "missing filters",
      '{"v":1,"intent":"topic","must":[],"should":[],"phrases":[],"exclude":[],"aspects":[],"sort":"top"}',
    ],
    ["bad media", JSON.stringify(xq({ filters: { media: "audio" as never } }))],
    ["fractional since", JSON.stringify(xq({ filters: { since: 1.5 } }))],
    ["pre-2000 since", JSON.stringify(xq({ filters: { since: 1234 } }))],
    ["negative minLikes", JSON.stringify(xq({ filters: { minLikes: -1 } }))],
    ["bad lang", JSON.stringify(xq({ filters: { lang: "english" } }))],
    [
      "13 must terms",
      JSON.stringify(xq({ must: Array.from({ length: 13 }, (_, i) => t(`w${i}`)) })),
    ],
  ])("rejects %s", (_name, json) => {
    expect(parseXQueryJson(json)).toBeNull();
  });
});

describe("mergeRefinement", () => {
  it("fills empty slots and reports them", () => {
    const base = xq({ must: [t("convex")] });
    const refined = xq({
      intent: Intent.Event,
      should: [t("rsc")],
      aspects: [t("~drama")],
      exclude: [t("jobs")],
      filters: { since: Date.UTC(2026, 0, 1), media: "video" },
    });
    const merge = mergeRefinement(base, refined);
    expect(merge.xq.intent).toBe(Intent.Event);
    expect(merge.xq.must).toEqual(["convex"]);
    expect(merge.xq.should).toEqual(["rsc"]);
    expect(merge.xq.aspects).toEqual(["~drama"]);
    expect(merge.xq.exclude).toEqual(["jobs"]);
    expect(merge.xq.filters.since).toBe(Date.UTC(2026, 0, 1));
    expect(merge.xq.filters.media).toBe("video");
    expect(merge.filled.sort()).toEqual([
      "aspects",
      "exclude",
      "filters.media",
      "filters.since",
      "intent",
      "should",
    ]);
    expect(merge.overridden).toEqual([]);
  });

  it("never overrides slots the base parse set", () => {
    const base = xq({
      intent: Intent.Question,
      must: [t("llm")],
      phrases: [[t("server"), t("components")]],
      exclude: [t("crypto")],
      filters: { authorId: "1" as AuthorId, media: "image", lang: "en" },
      sort: SortOrder.Latest,
    });
    const refined = xq({
      intent: Intent.Compare,
      must: [t("agents")],
      phrases: [[t("client"), t("components")]],
      exclude: [t("stocks")],
      filters: { authorId: "2" as AuthorId, media: "video", lang: "fr" },
      sort: SortOrder.Top,
    });
    const merge = mergeRefinement(base, refined);
    expect(merge.xq.intent).toBe(Intent.Question);
    expect(merge.xq.must).toEqual(["llm"]);
    // extra refined must terms demote to should — the gate set never tightens
    expect(merge.xq.should).toEqual(["agents"]);
    expect(merge.xq.phrases).toEqual(base.phrases);
    expect(merge.xq.exclude).toEqual(["crypto"]);
    expect(merge.xq.filters).toEqual(base.filters);
    expect(merge.xq.sort).toBe(SortOrder.Latest);
    expect(merge.overridden.sort()).toEqual([
      "exclude",
      "filters.authorId",
      "filters.lang",
      "filters.media",
      "intent",
      "phrases",
      "sort",
    ]);
  });

  it("fills must only when the base gate set is empty", () => {
    const base = xq({ filters: { authorId: "1" as AuthorId } });
    const refined = xq({ must: [t("keyboards")] });
    const merge = mergeRefinement(base, refined);
    expect(merge.xq.must).toEqual(["keyboards"]);
    expect(merge.filled).toEqual(["must"]);
  });

  it("deduplicates should additions against every other slot and caps at 12", () => {
    const base = xq({ must: [t("a")], should: [t("b")], exclude: [t("c")] });
    const refined = xq({
      should: [t("a"), t("b"), t("c"), ...Array.from({ length: 14 }, (_, i) => t(`s${i}`))],
    });
    const merge = mergeRefinement(base, refined);
    expect(merge.xq.should).toHaveLength(12);
    expect(merge.xq.should[0]).toBe("b");
    expect(merge.xq.should).not.toContain("a");
    expect(merge.xq.should).not.toContain("c");
  });

  it("does not mutate its inputs", () => {
    const base = xq({ must: [t("a")] });
    const refined = xq({ should: [t("b")], filters: { media: "gif" } });
    const baseJson = canonicalJson(base);
    const refinedJson = canonicalJson(refined);
    mergeRefinement(base, refined);
    expect(canonicalJson(base)).toBe(baseJson);
    expect(canonicalJson(refined)).toBe(refinedJson);
  });
});

describe("normalizeRaw", () => {
  it("trims and lowercases — the queryCache identity", () => {
    expect(normalizeRaw("  Linux BOX cheap ")).toBe("linux box cheap");
  });
});

describe("Effect Schema timestamp guard", () => {
  it.each([
    [Date.UTC(2000, 0, 1), true],
    [Date.UTC(2026, 8, 9), true],
    [Date.UTC(2100, 0, 1), true],
    [Date.UTC(1999, 11, 31), false],
    [Date.UTC(2100, 0, 1) + 1, false],
    [1.5, false],
    ["2026-09-09", false],
    [null, false],
  ])("validates %j as %s", (value, expected) => {
    expect(isEpochMs(value)).toBe(expected);
  });
});

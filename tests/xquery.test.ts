import { describe, expect, test } from "vitest";
import {
  emptyXQuery,
  mergeRefinement,
  parseXQueryJson,
} from "../convex/engine/xquery";

describe("XQuery boundary", () => {
  test("rejects malformed JSON and unknown enum values", () => {
    expect(parseXQueryJson("{")).toBeNull();
    expect(
      parseXQueryJson(JSON.stringify({ ...emptyXQuery(), intent: "unsupported" })),
    ).toBeNull();
  });

  test("decodes a complete canonical query", () => {
    const query = emptyXQuery();
    query.must = ["convex"];
    query.filters.media = "image";

    expect(parseXQueryJson(JSON.stringify(query))).toEqual(query);
  });

  test("refinement fills slots without overriding explicit filters or sort", () => {
    const base = emptyXQuery();
    base.must = ["convex"];
    base.filters.media = "image";
    base.sort = "latest";

    const refined = emptyXQuery();
    refined.intent = "event";
    refined.must = ["react"];
    refined.filters.media = "video";

    expect(mergeRefinement(base, refined)).toMatchObject({
      intent: "event",
      must: ["convex", "react"],
      filters: { media: "image" },
      sort: "latest",
    });
  });
});

import { describe, expect, test } from "vitest";
import { safeInterpretedQuery } from "../convex/interpret";

describe("LLM lexical interpretation boundary", () => {
  test("preserves explicit filters, sort, phrases and exclusions", () => {
    expect(
      safeInterpretedQuery('find react from:@theo sort:latest -angular "server components"', {
        query: "react compiler",
      }),
    ).toBe('react compiler "server components" from:@theo sort:latest -angular');
  });
  test("preserves explicit dates without exceeding the existing term budget", () => {
    expect(safeInterpretedQuery("react since:2024-01-01", { query: "react compiler" })).toBe(
      "react compiler since:2024-01-01",
    );
  });
  test.each([
    null,
    [],
    {},
    { query: "" },
    { query: "from:evil" },
    { query: "-react" },
    { query: '"other"' },
    { query: 42 },
    { query: "a".repeat(241) },
  ])("rejects unsafe output %j", (output) => {
    expect(safeInterpretedQuery("react", output)).toBeNull();
  });
  test("does not silently repair ambiguous names itself", () => {
    expect(safeInterpretedQuery("height of theo", { query: "theo height" })).toBe("theo height");
  });
});

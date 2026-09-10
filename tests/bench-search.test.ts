import { describe, expect, it } from "vitest";
import {
  parseQueries,
  positiveInteger,
  summarize,
  validateResponse,
} from "../scripts/bench-search-lib";

describe("benchmark evidence", () => {
  it("rejects invalid run counts instead of reporting empty percentiles", () => {
    for (const value of ["0", "-1", "NaN", "2.5", "", "9007199254740992"])
      expect(() => positiveInteger(value)).toThrow(/Expected a (positive|safe) integer/);
    expect(positiveInteger("2")).toBe(2);
    expect(summarize([])).toBeNull();
  });
  it("uses nearest rank without mutating observations or subtracting a floor", () => {
    const samples = [500, 80, 100, 90];
    expect(summarize(samples)).toEqual({ n: 4, p50Ms: 90, p95Ms: 500, minMs: 80, maxMs: 500 });
    expect(samples).toEqual([500, 80, 100, 90]);
    expect(() => summarize([NaN])).toThrow("Invalid latency.");
  });
  it("validates fixtures and preserves result floors as counts only", () => {
    expect(parseQueries({ queries: [{ raw: "bun" }] })).toEqual([{ raw: "bun", minResults: 0 }]);
    expect(() => parseQueries({ queries: [{ raw: "bun", minResults: -1 }] })).toThrow(
      "Invalid query fixture.",
    );
    expect(() => parseQueries({ queries: [] })).toThrow("Expected nonempty queries.");
  });
  it("captures ordered source IDs and rejects malformed or failed responses", () => {
    const value = {
      error: null,
      ladder: "L0",
      queryKey: "key",
      results: [{ tweetId: "b" }, { tweetId: "a" }],
    };
    expect(validateResponse({ status: "success", value }).ids).toEqual(["b", "a"]);
    expect(() => validateResponse({ status: "error" })).toThrow("Convex query failed.");
    expect(() =>
      validateResponse({ status: "success", value: { ...value, results: [{}] } }),
    ).toThrow("Missing source tweet ID.");
  });
});

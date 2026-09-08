import { describe, expect, test } from "vitest";
import {
  formatCount,
  normalizeHandle,
  parseFiniteNumber,
  parseNonEmptyString,
  parseNonNegativeNumber,
} from "../src/contracts/primitives.ts";
import { mean, percentile } from "../src/contracts/statistics.ts";

describe("collector shared contracts", () => {
  test("parses only finite, non-negative numeric boundary values", () => {
    expect(parseFiniteNumber(Number.NaN)).toBeNull();
    expect(parseFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseNonNegativeNumber(-1)).toBeNull();
    expect(parseNonNegativeNumber(0)).toBe(0);
  });

  test("normalizes non-empty handles without accepting blank values", () => {
    expect(parseNonEmptyString("  handle  ")).toBe("  handle  ");
    expect(parseNonEmptyString("   ")).toBeNull();
    expect(normalizeHandle("@Handle")).toBe("handle");
    expect(normalizeHandle(null)).toBeNull();
  });

  test("shares formatting and aggregate behavior", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(1_234)).toBe("1,234");
    expect(mean([])).toBeNull();
    expect(mean([2, 4])).toBe(3);
    expect(percentile([10, 20, 30], 0.5)).toBe(20);
  });
});

import { describe, expect, test } from "vitest";
import {
  formatCount,
  normalizeHandle,
  parseFiniteNumber,
  parseNonEmptyString,
  parseNonNegativeNumber,
} from "../src/contracts/primitives.ts";
import { mean, percentile } from "../src/contracts/statistics.ts";
import {
  IngressMediaType,
  parseProviderMediaType,
  ProviderMediaType,
  toIngressMediaType,
} from "../src/contracts/media.ts";
import {
  isStatusRow,
  isTombstoneRow,
  parseProviderFacetType,
} from "../src/contracts/provider.ts";
import {
  parseAccountState,
  parseDiscoveryResolution,
  parsePauseReason,
} from "../src/contracts/run-state.ts";
import {
  type AuthorId,
  parseAuthorId,
  parseHandle,
  parseQueryKey,
  parseTerm,
  parseTweetId,
} from "../src/contracts/ids.ts";

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

  test("keeps provider media values closed at the acquisition boundary", () => {
    // Unknown future formats decode to absence, never throw and never pass.
    expect(parseProviderMediaType("future_format")).toBeNull();
    expect(parseProviderMediaType(null)).toBeNull();
    expect(parseProviderMediaType(42)).toBeNull();
    // The mosaic/photo collapse is the one mapping that must never drift.
    expect(toIngressMediaType(ProviderMediaType.MosaicPhoto)).toBe(IngressMediaType.Image);
  });

  test("closes run-state and provider string unions at decode time", () => {
    expect(parseAccountState("running")).toBeNull();
    expect(parsePauseReason("timeout")).toBeNull();
    expect(parseDiscoveryResolution("pending")).toBeNull();
    expect(parseProviderFacetType("emoji")).toBeNull();
    expect(parseProviderFacetType(null)).toBeNull();
    expect(isStatusRow("deleted")).toBe(false);
    expect(isTombstoneRow(null)).toBe(false);
  });

  test("rejects every non-identity for branded domain ids", () => {
    // Failure matrix: blanks (including unicode whitespace), non-strings, and
    // hostile objects must all decode to absence — never throw, never pass.
    // Each parser shares parseNonEmptyString semantics, so one matrix covers all five.
    const hostile: unknown[] = [
      "",
      "   ",
      "\t\n ",
      " ",
      null,
      undefined,
      0,
      42,
      true,
      false,
      {},
      [],
      ["123"],
      { toString: () => "123" },
    ];
    for (const parse of [parseTweetId, parseAuthorId, parseHandle, parseTerm, parseQueryKey]) {
      for (const value of hostile) {
        expect(parse(value), `${parse.name}(${JSON.stringify(value)})`).toBeNull();
      }
    }
  });

  test("keeps brand separation at compile time", () => {
    // The assertion IS the compilation (tsc runs in CI): if the brands ever
    // collapse to plain string, the @ts-expect-error below becomes unused and
    // typechecking fails. No runtime behavior to assert — erasure is the point.
    const tweetId = parseTweetId("123");
    if (tweetId !== null) {
      // @ts-expect-error: TweetId must not be directly assignable to AuthorId
      const direct: AuthorId | null = tweetId;
      void direct;
    }
  });

  test("keeps values verbatim instead of trimming them", () => {
    // Non-blank input passes through untouched (normalization owns transforms).
    // Pinned so a well-meaning trim() cannot silently change stored ids.
    expect(parseTweetId("  123  ")).toBe("  123  ");
    expect(parseHandle("NASA")).toBe("NASA");
  });
});

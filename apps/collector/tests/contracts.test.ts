import { describe, expect, it, test } from "vitest";
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
  parseProviderStatusType,
  ProviderFacetType,
  ProviderStatusType,
} from "../src/contracts/provider.ts";
import {
  isAdmissibleDiscoveryResolution,
  isFinishedAccountState,
  isNormalizableAcquisitionStatus,
  isOpenAccountState,
  needsIdentityResolution,
  parseAccountState,
  parseDiscoveryResolution,
  parsePauseReason,
  AccountState,
  AcquisitionStatus,
  DiscoveryResolution,
  PauseReason,
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
  it.each([
    { value: Number.NaN, finite: null, nonNegative: null },
    { value: Number.POSITIVE_INFINITY, finite: null, nonNegative: null },
    { value: Number.NEGATIVE_INFINITY, finite: null, nonNegative: null },
    { value: -1, finite: -1, nonNegative: null },
    { value: -0.5, finite: -0.5, nonNegative: null },
    { value: 0, finite: 0, nonNegative: 0 },
    { value: 1, finite: 1, nonNegative: 1 },
    { value: 1.5, finite: 1.5, nonNegative: 1.5 },
    { value: "1", finite: null, nonNegative: null },
    { value: null, finite: null, nonNegative: null },
    { value: undefined, finite: null, nonNegative: null },
    { value: {}, finite: null, nonNegative: null },
  ])("numeric boundary $value", ({ value, finite, nonNegative }) => {
    expect(parseFiniteNumber(value)).toBe(finite);
    expect(parseNonNegativeNumber(value)).toBe(nonNegative);
  });

  it.each([
    { value: "  handle  ", parsed: "  handle  ", normalized: "  handle  " },
    { value: "   ", parsed: null, normalized: "   " },
    { value: "", parsed: null, normalized: "" },
    { value: "@Handle", parsed: "@Handle", normalized: "handle" },
    { value: "@NASA", parsed: "@NASA", normalized: "nasa" },
    { value: "NASA", parsed: "NASA", normalized: "nasa" },
    { value: 42, parsed: null, normalized: null },
    { value: null, parsed: null, normalized: null },
  ])("string boundary %j", ({ value, parsed, normalized }) => {
    expect(parseNonEmptyString(value)).toBe(parsed);
    expect(normalizeHandle(value as string | null)).toBe(normalized);
  });

  it.each([
    { value: null, formatted: "—" },
    { value: 0, formatted: "0" },
    { value: 1_234, formatted: "1,234" },
    { value: 1_000_000, formatted: "1,000,000" },
  ])("formatCount $value", ({ value, formatted }) => {
    expect(formatCount(value)).toBe(formatted);
  });

  it.each([
    { values: [], expected: null },
    { values: [2, 4], expected: 3 },
    { values: [5], expected: 5 },
    { values: [-2, 2], expected: 0 },
    { values: [1, 2, 3, 4], expected: 2.5 },
  ])("mean $values", ({ values, expected }) => {
    expect(mean(values)).toBe(expected);
  });

  it.each([
    { sorted: [], fraction: 0.5, expected: null },
    { sorted: [10, 20, 30], fraction: 0.5, expected: 20 },
    { sorted: [10, 20, 30], fraction: 0, expected: 10 },
    { sorted: [10, 20, 30], fraction: 1, expected: 30 },
    { sorted: [10, 20, 30], fraction: 0.34, expected: 20 },
    { sorted: [7], fraction: 0.99, expected: 7 },
  ])("percentile $sorted @ $fraction", ({ sorted, fraction, expected }) => {
    expect(percentile(sorted, fraction)).toBe(expected);
  });

  it.each([
    { value: "photo", parsed: ProviderMediaType.Photo, ingress: IngressMediaType.Image },
    {
      value: "mosaic_photo",
      parsed: ProviderMediaType.MosaicPhoto,
      ingress: IngressMediaType.Image,
    },
    { value: "video", parsed: ProviderMediaType.Video, ingress: IngressMediaType.Video },
    { value: "gif", parsed: ProviderMediaType.Gif, ingress: IngressMediaType.Gif },
    { value: "future_format", parsed: null, ingress: null },
    { value: null, parsed: null, ingress: null },
    { value: 42, parsed: null, ingress: null },
    { value: "IMAGE", parsed: null, ingress: null },
    { value: "", parsed: null, ingress: null },
  ])("provider media boundary %j", ({ value, parsed, ingress }) => {
    expect(parseProviderMediaType(value)).toBe(parsed);
    // One unconditional assertion: a null parse maps to a null ingress type.
    expect(parsed === null ? null : toIngressMediaType(parsed)).toBe(ingress);
  });

  it.each([
    { value: "status", status: true, tombstone: false },
    { value: "tombstone", status: false, tombstone: true },
    { value: "deleted", status: false, tombstone: false },
    { value: "emoji", status: false, tombstone: false },
    { value: null, status: false, tombstone: false },
    { value: 42, status: false, tombstone: false },
    { value: "STATUS", status: false, tombstone: false },
  ])("provider row kind %j", ({ value, status, tombstone }) => {
    expect(isStatusRow(value)).toBe(status);
    expect(isTombstoneRow(value)).toBe(tombstone);
  });

  it.each([
    { value: "hashtag", parsed: ProviderFacetType.Hashtag },
    { value: "mention", parsed: ProviderFacetType.Mention },
    { value: "url", parsed: ProviderFacetType.Url },
    { value: "emoji", parsed: null },
    { value: null, parsed: null },
    { value: "", parsed: null },
  ])("provider facet %j", ({ value, parsed }) => {
    expect(parseProviderFacetType(value)).toBe(parsed);
  });

  it.each([
    { value: "status", parsed: ProviderStatusType.Status },
    { value: "tombstone", parsed: ProviderStatusType.Tombstone },
    { value: "deleted", parsed: null },
    { value: null, parsed: null },
  ])("provider status %j", ({ value, parsed }) => {
    expect(parseProviderStatusType(value)).toBe(parsed);
  });

  it.each(Object.values(AccountState))("account state %j round-trips and classifies", (state) => {
    expect(parseAccountState(state)).toBe(state);
    expect(isOpenAccountState(state)).toBe(
      state === "pending" || state === "active" || state === "paused",
    );
    expect(isFinishedAccountState(state)).toBe(state === "completed" || state === "abandoned");
  });

  it.each(["running", "timeout", "", null, 42, "PENDING", "Active"])(
    "run-state rejects non-union %j",
    (value) => {
      expect(parseAccountState(value)).toBeNull();
      expect(parsePauseReason(value)).toBeNull();
      expect(parseDiscoveryResolution(value)).toBeNull();
    },
  );

  it.each(Object.values(PauseReason))("pause reason %j round-trips", (reason) => {
    expect(parsePauseReason(reason)).toBe(reason);
    expect(needsIdentityResolution(reason)).toBe(
      reason === "identity_mismatch" ||
        reason === "profile_not_found" ||
        reason === "profile_protected",
    );
  });

  it.each(Object.values(DiscoveryResolution))("discovery resolution %j", (resolution) => {
    expect(parseDiscoveryResolution(resolution)).toBe(resolution);
    expect(isAdmissibleDiscoveryResolution(resolution)).toBe(
      resolution === "embedded" || resolution === "resolved",
    );
  });

  it.each(Object.values(AcquisitionStatus))("acquisition status %j", (status) => {
    expect(isNormalizableAcquisitionStatus(status)).toBe(
      status === "completed" || status === "partial",
    );
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
    expect.assertions(0);
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

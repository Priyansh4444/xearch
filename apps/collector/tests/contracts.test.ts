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
  CandidateOrigin,
  InteractionKind,
  SkipReason,
} from "../src/contracts/normalize-kinds.ts";
import {
  isStatusRow,
  isTombstoneRow,
  parseProviderFacetType,
  ProviderFacetType,
  ProviderStatusType,
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
    expect(parseProviderMediaType(ProviderMediaType.Photo)).toBe(ProviderMediaType.Photo);
    expect(parseProviderMediaType("future_format")).toBeNull();
    expect(toIngressMediaType(ProviderMediaType.MosaicPhoto)).toBe(IngressMediaType.Image);
  });

  test("closes run-state and provider string unions at decode time", () => {
    expect(parseAccountState("paused")).toBe("paused");
    expect(parseAccountState("running")).toBeNull();
    expect(parsePauseReason("invalid_response")).toBe("invalid_response");
    expect(parsePauseReason("timeout")).toBeNull();
    expect(parseDiscoveryResolution("resolved")).toBe("resolved");
    expect(parseDiscoveryResolution("pending")).toBeNull();
    expect(isStatusRow(ProviderStatusType.Status)).toBe(true);
    expect(isTombstoneRow(ProviderStatusType.Tombstone)).toBe(true);
    expect(parseProviderFacetType(ProviderFacetType.Mention)).toBe(ProviderFacetType.Mention);
    expect(parseProviderFacetType("emoji")).toBeNull();
    expect(CandidateOrigin.Timeline).toBe("timeline");
    expect(SkipReason.OutsideHistoryWindow).toBe("outside_history_window");
    expect(InteractionKind.Mention).toBe("mention");
  });

  test("brands domain identities without changing their runtime values", () => {
    expect(parseTweetId("123")).toBe("123");
    expect(parseAuthorId("456")).toBe("456");
    expect(parseHandle("nasa")).toBe("nasa");
    expect(parseTerm("convex")).toBe("convex");
    expect(parseQueryKey("0123456789abcdef")).toBe("0123456789abcdef");
    // Same blank rejection as parseNonEmptyString: brands add types, not behavior.
    for (const parse of [parseTweetId, parseAuthorId, parseHandle, parseTerm, parseQueryKey]) {
      expect(parse("")).toBeNull();
      expect(parse("   ")).toBeNull();
      expect(parse(null)).toBeNull();
      expect(parse(42)).toBeNull();
    }
    // Branded values serialize exactly like the strings they wrap.
    expect(JSON.stringify({ id: parseTweetId("123"), authorId: parseAuthorId("456") })).toBe(
      '{"id":"123","authorId":"456"}',
    );
    // A tweet id is not an author id, even though both erase to string.
    const tweetId = parseTweetId("123");
    if (tweetId !== null) {
      const authorId: AuthorId | null = tweetId as unknown as AuthorId | null;
      expect(authorId).toBe("123");
      // @ts-expect-error: TweetId must not be directly assignable to AuthorId
      const direct: AuthorId | null = tweetId;
      expect(direct).toBe("123");
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AuthorId } from "../convex/contracts/ids";
import { tierA, tierB, type TierBDeps } from "../convex/engine/parse";

const THEO = "author-theo" as AuthorId;
const OTHER = "author-other" as AuthorId;

function dependencies(authors: Readonly<Record<string, AuthorId>> = { theo: THEO }) {
  const resolveEntity = vi.fn<TierBDeps["resolveEntity"]>(async (tokens) => {
    const authorId = authors[tokens.join("")];
    return authorId === undefined ? null : { authorId };
  });
  const resolveHandle = vi.fn<TierBDeps["resolveHandle"]>(async (handle) => {
    const authorId = authors[handle];
    return authorId === undefined ? null : { authorId };
  });
  const dfOf = vi.fn<TierBDeps["dfOf"]>(async () => null);
  const deps = {
    resolveEntity,
    resolveHandle,
    dfOf,
    now: () => Date.UTC(2026, 8, 7),
  } satisfies TierBDeps;
  return deps;
}

describe("subject questions are not author filters", () => {
  it("keeps the subject of height of theo, even if height also names an account", async () => {
    const deps = dependencies({ theo: THEO, height: OTHER });
    const parsed = tierA("height of theo");
    expect(parsed.xq.must).toEqual(["height", "theo"]);
    expect(parsed.xq.filters.authorId).toBeNull();
    const { xq, trace } = await tierB(parsed, deps);
    expect(xq.must).toEqual(["theo"]);
    expect(xq.should).toEqual(["height"]);
    expect(xq.aspects).toEqual(["~spec"]);
    expect(xq.intent).toBe("question");
    expect(xq.filters.authorId).toBeNull();
    expect(trace.consumed["theo"]).toBeUndefined();
    expect(deps.resolveEntity).not.toHaveBeenCalled();
    expect(deps.dfOf).not.toHaveBeenCalled();
  });

  it.each([
    "height of theo",
    "weight of theo",
    "size of theo",
    "what is theo?",
    "who is theo?",
    "how tall is theo?",
    "why is theo famous?",
    "theo?",
    "what about theo",
    "photos of theo",
    "theo react",
  ])("does not interpret %j as tweets by Theo", async (raw) => {
    const deps = dependencies();
    const { xq } = await tierB(tierA(raw), deps);
    expect(xq.must).toContain("theo");
    expect(xq.filters.authorId).toBeNull();
    expect(deps.resolveEntity).not.toHaveBeenCalled();
  });
});

describe("explicit speaker attribution", () => {
  it.each([
    "what did theo say about react?",
    "what does theo say about react?",
    "What did THEO say about react?",
    "what did @theo say about react?",
  ])("resolves only the named speaker in %j", async (raw) => {
    const deps = dependencies({ theo: THEO, react: OTHER });
    const { xq } = await tierB(tierA(raw), deps);
    expect(xq.filters.authorId).toBe(THEO);
    expect(xq.must).toEqual(["react"]);
    expect(xq.intent).toBe("question");
    expect(deps.resolveEntity.mock.calls).toEqual([[["theo"]]]);
    expect(deps.dfOf).not.toHaveBeenCalled();
  });

  it("never falls back to an account named by the topic when the speaker is unknown", async () => {
    const deps = dependencies({ react: OTHER });
    const { xq } = await tierB(tierA("what did unknown say about react?"), deps);
    expect(xq.must).toEqual(["unknown", "react"]);
    expect(xq.filters.authorId).toBeNull();
    expect(deps.resolveEntity.mock.calls).toEqual([[["unknown"]]]);
  });

  it("preserves bare account lookup", async () => {
    const deps = dependencies();
    const { xq } = await tierB(tierA("theo"), deps);
    expect(xq.filters.authorId).toBe(THEO);
    expect(xq.intent).toBe("person");
    expect(xq.must).toEqual([]);
    expect(deps.resolveEntity.mock.calls).toEqual([[["theo"]]]);
  });
});

describe("explicit filters and literal spelling remain authoritative", () => {
  it.each(["height of theo", "what did theo say about react?", "theo"])(
    "does not entity-link %j when from: is unknown",
    async (raw) => {
      const deps = dependencies();
      const { xq, trace } = await tierB(tierA(`from:missing ${raw}`), deps);
      expect(xq.filters.authorId).toBeNull();
      expect(trace.leftover).toContain("from:missing");
      expect(deps.resolveEntity).not.toHaveBeenCalled();
      expect(deps.resolveHandle).toHaveBeenCalledExactlyOnceWith("missing");
    },
  );

  it("keeps explicit author, phrase, negation, media, sort, and date filters", async () => {
    const deps = dependencies({ theo: THEO, other: OTHER });
    const { xq } = await tierB(
      tierA('from:other "height of theo" -tall has:image sort:latest since:2026-01-01'),
      deps,
    );
    expect(xq.filters.authorId).toBe(OTHER);
    expect(xq.phrases).toEqual([["height", "of", "theo"]]);
    expect(xq.exclude).toEqual(["tall"]);
    expect(xq.filters.media).toBe("image");
    expect(xq.filters.since).toBe(Date.UTC(2026, 0, 1));
    expect(xq.sort).toBe("latest");
    expect(deps.resolveEntity).not.toHaveBeenCalled();
  });

  it.each(["hieght of theo", "theoo", "what did theoo say about react?"])(
    "never silently repairs %j or probes a spelling neighborhood",
    async (raw) => {
      const deps = dependencies();
      const { xq } = await tierB(tierA(raw), deps);
      expect(xq.must).toContain(raw.startsWith("hieght") ? "hieght" : "theoo");
      expect(xq.filters.authorId).toBeNull();
      expect(deps.resolveEntity.mock.calls.length).toBeLessThanOrEqual(1);
      expect(deps.dfOf).not.toHaveBeenCalled();
    },
  );
});

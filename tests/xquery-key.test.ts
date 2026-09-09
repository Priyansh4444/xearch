// Query-key stability: canonicalJson/queryKey is the identity used by queryCache,
// answers, and feedback aggregation. Two XQuery values meaning the same thing
// MUST serialize identically or votes and cache rows split across keys.

import { describe, expect, it } from "vitest";
import { canonicalJson, emptyXQuery, queryKey } from "../convex/engine/xquery";
import type { Term } from "../convex/contracts/ids";

const t = (s: string): Term => s as Term;

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([xs[i]!, ...tail]);
  }
  return out;
}

describe("query key stability", () => {
  it("term order in every list leaves the key unchanged (all 24 must-orders)", () => {
    const terms = [t("linux"), t("box"), t("cheap"), t("kernel")];
    const baseline = queryKey({ ...emptyXQuery(), must: terms });
    expect(baseline).toMatch(/^[0-9a-f]{16}$/);
    for (const order of permutations(terms)) {
      expect(queryKey({ ...emptyXQuery(), must: order })).toBe(baseline);
      expect(queryKey({ ...emptyXQuery(), should: order })).toBe(
        queryKey({ ...emptyXQuery(), should: terms }),
      );
      expect(queryKey({ ...emptyXQuery(), exclude: order })).toBe(
        queryKey({ ...emptyXQuery(), exclude: terms }),
      );
    }
  });

  it("phrase order leaves the key unchanged", () => {
    const phrases = [
      [t("apple"), t("tree")],
      [t("box"), t("linux")],
      [t("red"), t("hat")],
    ];
    const baseline = queryKey({ ...emptyXQuery(), phrases });
    for (const order of permutations(phrases)) {
      expect(queryKey({ ...emptyXQuery(), phrases: order })).toBe(baseline);
    }
  });

  it("shared-prefix phrases share one key across every input order (all 6)", () => {
    // Regression: canonicalJson compared phrases by first token only, so
    // [["a","x"],["a","y"]] and [["a","y"],["a","x"]] hashed differently and
    // split queryCache answers and feedback totals.
    const phrases = [
      [t("a"), t("x")],
      [t("a"), t("y")],
      [t("b"), t("a")],
    ];
    const baseline = queryKey({ ...emptyXQuery(), phrases });
    for (const order of permutations(phrases)) {
      expect(queryKey({ ...emptyXQuery(), phrases: order })).toBe(baseline);
    }
  });

  it.each([
    {
      name: "extra must term",
      mutate: (xq: ReturnType<typeof emptyXQuery>) => ({ ...xq, must: [...xq.must, t("extra")] }),
    },
    {
      name: "sort flip",
      mutate: (xq: ReturnType<typeof emptyXQuery>) => ({ ...xq, sort: "latest" as const }),
    },
    {
      name: "author filter",
      mutate: (xq: ReturnType<typeof emptyXQuery>) => ({
        ...xq,
        filters: { ...xq.filters, authorId: "a1" as never },
      }),
    },
    {
      name: "since filter",
      mutate: (xq: ReturnType<typeof emptyXQuery>) => ({
        ...xq,
        filters: { ...xq.filters, since: 123 },
      }),
    },
    {
      name: "intent flip",
      mutate: (xq: ReturnType<typeof emptyXQuery>) => ({ ...xq, intent: "question" as const }),
    },
  ])("meaning change $name changes the key", ({ mutate }) => {
    const base = { ...emptyXQuery(), must: [t("linux")] };
    expect(queryKey(mutate(base))).not.toBe(queryKey(base));
  });

  it("canonical JSON has fixed key order regardless of construction order", () => {
    const a = { ...emptyXQuery(), must: [t("b"), t("a")] };
    const b = { ...emptyXQuery(), must: [t("a"), t("b")] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

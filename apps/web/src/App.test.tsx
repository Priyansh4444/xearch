// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, it, vi } from "vitest";
import { MediaType } from "../../../convex/contracts/media";
import { LadderLevel } from "../../../convex/engine/plan";
import { emptyXQuery } from "../../../convex/engine/xquery";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  query: vi.fn<(reference: unknown, args: unknown) => unknown>(),
  vote: vi.fn<() => Promise<void>>(),
}));
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.query(args[0], args[1]),
  useMutation: () => mocks.vote,
}));

let root: Root;
let container: HTMLDivElement;
let full: unknown;
let canVote: boolean;

function response(error: string | null = null) {
  return {
    error,
    queryKey: "0000000000000001",
    ladder: LadderLevel.L0,
    appliedQuery: emptyXQuery(),
    trace: { consumed: {} },
    didYouMean: null,
    candidateCount: error === null ? 1 : 0,
    asOf: 1_700_000_000_000,
    nextPrefix: [],
    prefixDropped: false,
    results:
      error === null
        ? [
            {
              _id: "tweet-1",
              tweetId: "123",
              authorHandle: "theo",
              author: null,
              text: "apple result",
              createdAt: 1,
              likeCount: 0,
              retweetCount: 0,
              replyCount: 0,
              quoteCount: 0,
              mediaType: MediaType.None,
              mediaUrls: [],
            },
          ]
        : [],
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/?q=apple");
  full = response();
  canVote = false;
  mocks.query.mockImplementation((reference, args) => {
    if (args === "skip") return undefined;
    switch (getFunctionName(reference as FunctionReference<"query">)) {
      case "search:search":
        return full;
      case "search:suggest":
        return [
          { term: "theo", df: 4, kind: "author" },
          { term: "thread", df: 80, kind: "term" },
        ];
      case "feedback:canVote":
        return canVote;
      default:
        return undefined;
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => root.render(<App />));
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it.each([
  { initialUrl: "/?q=apple", clickTab: "Latest" },
  { initialUrl: "/?q=apple&sort=latest", clickTab: "Top" },
])(
  "sort change $initialUrl -> $clickTab shows loading, never stale results",
  async ({ initialUrl, clickTab }) => {
    window.history.replaceState(null, "", initialUrl);
    await render();
    expect(container.textContent).toContain("apple result");
    full = undefined;
    await click(clickTab);
    expect(container.textContent).not.toContain("apple result");
    expect(container.querySelector('[aria-label="Loading results"]')).not.toBeNull();
  },
);

it.each([
  { initialUrl: "/?q=apple", toggle: "lane: xearch", after: "lane: baseline" },
  { initialUrl: "/?q=apple&lane=baseline", toggle: "lane: baseline", after: "lane: xearch" },
])(
  "lane toggle $initialUrl ($toggle) shows loading, never stale results",
  async ({ initialUrl, toggle, after }) => {
    window.history.replaceState(null, "", initialUrl);
    await render();
    full = undefined;
    await click(toggle);
    // The toggle label must flip — loading alone would also show if the click
    // did nothing on the baseline start.
    expect(container.querySelector(".lane-toggle")?.textContent).toContain(after);
    expect(container.querySelector('[aria-label="Loading results"]')).not.toBeNull();
  },
);

test("all-stopword queries offer the literal lane instead of a dead end", async () => {
  full = { ...response(), results: [] };
  await render();
  expect(container.textContent).toContain("dropped by the posting index");
  await click("search the literal lane");
  expect(container.querySelector(".lane-toggle")?.textContent).toContain("lane: baseline");
});

test("load more grows the page and keeps the previous rows while loading", async () => {
  const rows = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({
      ...(response().results[0] as object),
      _id: `t-${offset + i}`,
      tweetId: `${offset + i}`,
      text: `apple ${offset + i}`,
    }));
  const refs = rows(20).map((row, i) => ({
    id: `t-${i}`,
    matchedVia: "L0" as const,
    score: 1 + i,
    parts: { rel: 1 },
  }));
  full = {
    ...response(),
    results: rows(20),
    didYouMean: null,
    candidateCount: 60,
    nextPrefix: refs,
  };
  await render();
  expect(container.textContent).toContain("20 of 60 ranked posts");
  expect(container.querySelector(".load-more")?.textContent).toContain("40 left");

  // The next page is in flight: previous rows stay on screen, button shows loading.
  full = undefined;
  await click("Load more (40 left)");
  expect(container.querySelectorAll(".results li").length).toBe(20);
  expect(container.querySelector(".load-more")?.textContent).toContain("Loading");
  const searchArgs = mocks.query.mock.calls
    .map(
      ([, args]) =>
        args as
          | {
              raw?: string;
              limit?: number;
              asOf?: number;
              prefix?: { id: string; matchedVia: string; score: number; parts: unknown }[];
              prefixQueryKey?: string;
            }
          | undefined,
    )
    .filter((args) => args?.raw === "apple");
  // The first page omits asOf/prefix; load more echoes the response's snapshot
  // and the displayed rows so nothing already shown can move.
  expect(searchArgs[0]?.asOf).toBeUndefined();
  expect(searchArgs[0]?.prefix).toBeUndefined();
  const continuation = searchArgs.find((args) => args?.limit === 40);
  expect(continuation?.asOf).toBe(1_700_000_000_000);
  expect(continuation?.prefix).toEqual(refs);
  // The prefix is bound to the query interpretation that minted it.
  expect(continuation?.prefixQueryKey).toBe("0000000000000001");

  full = {
    ...response(),
    results: rows(40),
    didYouMean: null,
    candidateCount: 60,
    nextPrefix: refs,
  };
  await render();
  expect(container.textContent).toContain("40 of 60 ranked posts");
  expect(container.querySelectorAll(".results li").length).toBe(40);
});

test("paged results keep first-page metadata and drop chain duplicates", async () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...(response().results[0] as object),
      _id: `t-${i}`,
      tweetId: `${i}`,
      text: `apple ${i}`,
    }));
  const refs = rows(20).map((row, i) => ({
    id: `t-${i}`,
    matchedVia: "L0" as const,
    score: 1,
    parts: { rel: 1 },
  }));
  full = {
    ...response(),
    ladder: LadderLevel.L2,
    results: rows(20),
    didYouMean: null,
    candidateCount: 60,
    nextPrefix: refs,
  };
  await render();
  expect(container.textContent).toContain("widened to related posts (L2)");

  // Open the prefix sequence (this is what freezes page-one metadata), then let
  // page two arrive: prefix rows first (same order), a chain duplicate of row
  // 0, and one genuinely new row in the live tail.
  await click("Load more (40 left)");
  full = {
    ...response(),
    ladder: LadderLevel.L0,
    results: [
      ...rows(20),
      { ...(response().results[0] as object), _id: "dup", tweetId: "0", quotedTweetId: "0" },
      { ...(response().results[0] as object), _id: "new", tweetId: "999", text: "apple new" },
    ],
    didYouMean: null,
    candidateCount: 60,
    nextPrefix: refs,
  };
  await render();
  // The duplicate chain is filtered; the new tail row renders.
  expect(container.querySelectorAll(".results li").length).toBe(21);
  expect(container.textContent).toContain("apple new");
  // The widened notice still describes the pinned page, not the re-parse.
  expect(container.textContent).toContain("widened to related posts (L2)");
});

test("a dropped prefix falls back to the fresh ranking metadata", async () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...(response().results[0] as object),
      _id: `t-${i}`,
      tweetId: `${i}`,
      text: `apple ${i}`,
    }));
  const refs = rows(20).map((row, i) => ({
    id: `t-${i}`,
    matchedVia: "L0" as const,
    score: 1,
    parts: { rel: 1 },
  }));
  full = {
    ...response(),
    ladder: LadderLevel.L2,
    results: rows(20),
    didYouMean: null,
    candidateCount: 60,
    nextPrefix: refs,
  };
  await render();
  expect(container.textContent).toContain("widened to related posts (L2)");

  await click("Load more (40 left)");
  full = {
    ...response(),
    ladder: LadderLevel.L0,
    prefixDropped: true,
    results: rows(20),
    didYouMean: null,
    candidateCount: 20,
    nextPrefix: [],
  };
  await render();
  expect(container.textContent).not.toContain("widened to related posts (L2)");
});

test("a video that cannot play falls back to an open link", async () => {
  const videoUrl = "https://video.twimg.com/amplify_video/1/vid/avc1/3840x2160/clip.mp4?tag=28";
  full = {
    ...response(),
    results: [
      {
        ...(response().results[0] as object),
        mediaType: MediaType.Video,
        mediaUrls: [videoUrl],
      },
    ],
  };
  await render();
  const video = container.querySelector("video");
  expect(video).not.toBeNull();
  expect(video?.querySelector("source")?.getAttribute("type")).toBe("video/mp4");
  expect(video?.getAttribute("src")).toBeNull();

  await act(async () => {
    video!.dispatchEvent(new Event("error"));
  });
  expect(container.querySelector("video")).toBeNull();
  const link = container.querySelector(".media-fallback a");
  expect(link?.getAttribute("href")).toBe(videoUrl);
  expect(container.textContent).toContain("This browser can’t play this video.");
});

test("stopword-only phrases and exclude-only queries also offer the literal lane", async () => {
  for (const appliedQuery of [
    { ...emptyXQuery(), phrases: [["the", "and"]] },
    { ...emptyXQuery(), exclude: ["apple"] },
  ]) {
    full = { ...response(), appliedQuery, results: [] };
    await render();
    expect(container.textContent).toContain("dropped by the posting index");
  }
  // A from:-only query reads the author timeline, so it keeps the normal copy.
  full = {
    ...response(),
    appliedQuery: { ...emptyXQuery(), filters: { ...emptyXQuery().filters, authorId: "a" } },
    results: [],
  };
  await render();
  expect(container.textContent).not.toContain("dropped by the posting index");
});

test("unknown author errors are recoverable in the search screen", async () => {
  full = response("Unknown author: missing.");
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unknown author: missing.");
  expect(container.querySelector("input")).not.toBeNull();
  full = response();
  await render();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("anonymous users have no voting controls; failed writes never show success", async () => {
  await render();
  expect(container.querySelector('[aria-label="Good result for this search"]')).toBeNull();
  canVote = true;
  mocks.vote.mockRejectedValue(new Error("offline"));
  await render();
  await click("+1");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Vote failed");
  expect(container.querySelector(".vote.on")).toBeNull();
  mocks.vote.mockResolvedValue(undefined);
  await click("+1");
  expect(container.querySelector(".vote.on")?.textContent).toBe("+1");
});

test("related posts render under a Related heading after exact hits", async () => {
  full = {
    ...response(),
    ladder: LadderLevel.L2,
    results: [
      {
        ...(response().results[0] as object),
        _id: "exact-1",
        tweetId: "1",
        text: "apple tree",
        matchedVia: LadderLevel.L0,
      },
      {
        ...(response().results[0] as object),
        _id: "related-1",
        tweetId: "2",
        text: "just apple",
        matchedVia: LadderLevel.L2,
      },
    ],
  };
  await render();
  expect(container.querySelector('[aria-label="Exact matches"]')?.textContent).toContain(
    "apple tree",
  );
  expect(container.querySelector("h2.related-label")?.textContent).toBe("Related");
  expect(container.querySelector('[aria-label="Related posts"]')?.textContent).toContain(
    "just apple",
  );
});

test("from: typeahead offers account completions while the box is focused", async () => {
  window.history.replaceState(null, "", "/?q=from:th");
  full = response();
  await render();
  const box = container.querySelector("input");
  expect(box?.value).toBe("from:th");
  await act(async () => {
    box?.focus();
  });
  const option = [...container.querySelectorAll('[role="option"]')].find((el) =>
    el.textContent?.includes("@theo"),
  );
  expect(option).toBeDefined();
});

it.each(["+1", "-1"] as const)(
  "vote %j: offline failure shows an error and never a success state",
  async (label) => {
    await render();
    canVote = true;
    mocks.vote.mockRejectedValue(new Error("offline"));
    await render();
    await click(label);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Vote failed");
    expect(container.querySelector(".vote.on")).toBeNull();
    mocks.vote.mockResolvedValue(undefined);
    await click(label);
    expect(container.querySelector(".vote.on")?.textContent).toBe(label);
  },
);

test("search box does not show a hardcoded corpus total", async () => {
  await render();
  const box = container.querySelector('input[aria-label="Search posts"]');
  expect(box?.getAttribute("placeholder")).toBe("Search posts");
  expect(box?.getAttribute("placeholder")).not.toMatch(/\d/);
});

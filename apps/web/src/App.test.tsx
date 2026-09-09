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

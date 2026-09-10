// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, it, vi } from "vitest";
import { MediaType } from "../../../convex/contracts/media";
import { LadderLevel } from "../../../convex/engine/plan";
import { emptyXQuery } from "../../../convex/engine/xquery";
import type { Interpretation } from "../../../convex/interpret";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  query: vi.fn<(reference: unknown, args: unknown) => unknown>(),
  paginated: vi.fn<(reference: unknown, args: unknown, options: unknown) => unknown>(),
  loadMore: vi.fn<(count: number) => void>(),
  vote: vi.fn<() => Promise<void>>(),
  interpret: vi.fn<(args: { raw: string }) => Promise<Interpretation>>(),
}));
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.query(args[0], args[1]),
  usePaginatedQuery: (...args: unknown[]) => mocks.paginated(args[0], args[1], args[2]),
  useMutation: () => mocks.vote,
  useAction: () => mocks.interpret,
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
    refined: null,
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
  window.history.replaceState(null, "", "/?q=apple&lane=xearch");
  full = response();
  canVote = false;
  mocks.paginated.mockReturnValue({
    results: response().results,
    status: "Exhausted",
    loadMore: mocks.loadMore,
  });
  mocks.interpret.mockResolvedValue({
    status: "unavailable",
    message: "AI interpretation is not enabled.",
  });
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
  { initialUrl: "/?q=apple&lane=xearch", clickTab: "Latest" },
  { initialUrl: "/?q=apple&lane=xearch&sort=latest", clickTab: "Top" },
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
  { initialUrl: "/?q=apple&lane=xearch", toggle: "lane: xearch", after: "lane: baseline" },
  { initialUrl: "/?q=apple&lane=baseline", toggle: "lane: baseline", after: "lane: xearch" },
])(
  "lane toggle $initialUrl ($toggle) shows loading, never stale results",
  async ({ initialUrl, toggle, after }) => {
    window.history.replaceState(null, "", initialUrl);
    await render();
    full = undefined;
    if (after === "lane: baseline") {
      mocks.paginated.mockReturnValue({
        results: [],
        status: "LoadingFirstPage",
        loadMore: mocks.loadMore,
      });
    }
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

test("baseline is default and interpreting requires an explicit click", async () => {
  window.history.replaceState(null, "", "/?q=react");
  await render();
  expect(container.querySelector(".lane-toggle")?.textContent).toBe("lane: baseline");
  expect(mocks.interpret).not.toHaveBeenCalled();
  await click("Interpret with AI");
  expect(mocks.interpret).toHaveBeenCalledExactlyOnceWith({ raw: "react" });
  expect(container.textContent).toContain("AI interpretation is not enabled.");
  expect(window.location.search).toBe("?q=react");
});

test("a stopword-only query offers the literal lane instead of a dead end", async () => {
  window.history.replaceState(null, "", "/?q=and+so+is&lane=xearch");
  full = { ...response(), results: [] };
  await render();
  expect(container.textContent).toContain(
    "Every word in this query is a stopword, so the posting index has no entries for it.",
  );
  await click("Search the literal lane");
  expect(container.querySelector(".lane-toggle")?.textContent).toBe("lane: baseline");
});

test("baseline exposes current client latency and loads another bounded page", async () => {
  window.history.replaceState(null, "", "/?q=react");
  mocks.paginated.mockReturnValue({
    results: response().results,
    status: "CanLoadMore",
    loadMore: mocks.loadMore,
  });
  await render();
  expect(container.textContent).toMatch(/\d+ ms client/);
  await click("Load more");
  expect(mocks.loadMore).toHaveBeenCalledExactlyOnceWith(20);
});

test("typing debounces reactive search instead of querying every keystroke", async () => {
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", "/?q=apple");
    await render();
    const input = container.querySelector("input")!;
    await act(async () => {
      Reflect.apply(
        // oxlint-disable-next-line typescript/unbound-method -- bypass React's tracked setter
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!,
        input,
        ["react"],
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(window.location.search).toBe("?q=apple");
    await act(async () => vi.advanceTimersByTime(149));
    expect(window.location.search).toBe("?q=apple");
    await act(async () => vi.advanceTimersByTime(1));
    expect(window.location.search).toBe("?q=react");
  } finally {
    vi.useRealTimers();
  }
});

test("interpretation requires review and Apply switches to baseline", async () => {
  mocks.interpret.mockResolvedValue({ status: "ready", query: "react compiler" });
  await render();
  await click("Interpret with AI");
  expect(window.location.search).toContain("q=apple");
  await click("Apply interpretation");
  expect(window.location.search).toBe("?q=react+compiler");
  expect(container.querySelector(".lane-toggle")?.textContent).toBe("lane: baseline");
});

test("arrivals subscribe only after opt-in and can pause", async () => {
  window.history.replaceState(null, "", "/");
  await render();
  await click("Watch arrivals");
  expect(container.textContent).toContain("Connecting to arrivals");
  await click("Pause arrivals");
  expect(container.textContent).not.toContain("Connecting to arrivals");
  expect(mocks.interpret).not.toHaveBeenCalled();
});

test("signed-in users can report a bad query once", async () => {
  canVote = true;
  mocks.vote.mockResolvedValue(undefined);
  await render();
  await click("Report bad search");
  expect(mocks.vote).toHaveBeenCalledWith({
    raw: "apple",
    lane: "xearch",
    reason: "bad-results",
  });
  expect(container.textContent).toContain("Search reported");
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

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { emptyXQuery } from "../../../convex/engine/xquery";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  vote: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.query(...args),
  useMutation: () => mocks.vote,
}));

let root: Root;
let container: HTMLDivElement;
let full: unknown;
let canVote: boolean;

function response(error: string | null = null) {
  return {
    error, queryKey: "0000000000000001", ladder: "L0",
    appliedQuery: emptyXQuery(), trace: { consumed: {} },
    results: error === null ? [{
      _id: "tweet-1", tweetId: "123", authorHandle: "theo",
      author: null, text: "apple result", createdAt: 1,
      likeCount: 0, retweetCount: 0, replyCount: 0, quoteCount: 0,
      mediaType: "none", mediaUrls: [],
    }] : [],
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/?q=apple");
  full = response();
  canVote = false;
  mocks.query.mockImplementation((reference, args) => {
    if (args === "skip") return undefined;
    switch (getFunctionName(reference)) {
      case "search:search": return full;
      case "feedback:canVote": return canVote;
      default: return undefined;
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
  const button = [...container.querySelectorAll("button")].find((element) => element.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test("sort and lane changes show loading instead of stale results", async () => {
  await render();
  expect(container.textContent).toContain("apple result");
  full = undefined;
  await click("Latest");
  expect(container.textContent).not.toContain("apple result");
  expect(container.querySelector('[aria-label="Loading results"]')).not.toBeNull();
  full = response();
  await render();
  expect(container.textContent).toContain("apple result");
  await click("lane: xearch");
  expect(container.textContent).not.toContain("apple result");
  expect(container.querySelector('[aria-label="Loading results"]')).not.toBeNull();
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

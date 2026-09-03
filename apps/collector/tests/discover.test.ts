import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fxtwitter/pages.json" with { type: "json" };
import type { PilotClient, ProfileResponse } from "../src/acquisition/fxtwitter.ts";
import type { PilotConfig } from "../src/config/pilot.ts";
import { discoverFromPages, proposeConfig, renderMarkdown, resolveCandidates } from "../src/pilot/discover.ts";
import type { RawPageInput } from "../src/normalization/normalize.ts";

const pages: RawPageInput[] = fixture.pages.map((page) => ({ ...page, rawFile: "raw/x.json" }));
const seeds = fixture.accounts;

describe("gate-2 discovery", () => {
  it("counts distinct seeds per account across replies, quotes, reposts, and mentions", () => {
    const candidates = discoverFromPages(pages, {
      seeds,
      configuredIds: new Set(seeds.map((seed) => seed.userId)),
      configuredHandles: new Set(seeds.map((seed) => seed.handle)),
      minSeeds: 1,
    });
    const byHandle = Object.fromEntries(candidates.map((candidate) => [candidate.handle, candidate]));

    // @quoted (id 300) was quoted by seed 100 once.
    expect(byHandle.quoted).toMatchObject({ userId: "300", seeds: ["100"], interactions: { quote: 1, reply: 0, repost: 0, mention: 0 }, followers: 1000 });
    // @original (id 400) was reposted by seed 100.
    expect(byHandle.original).toMatchObject({ userId: "400", interactions: { repost: 1 } });
    // @friend was replied to and mentioned by seed 100; no id anywhere, so unresolved.
    expect(byHandle.friend).toMatchObject({ userId: null, resolution: "unresolved", seeds: ["100"], interactions: { reply: 1, mention: 0 } });
    // Seed 200 reposting seed 100's posts must not turn seed 100 into a candidate.
    expect(byHandle.seed).toBeUndefined();
  });

  it("applies the seed threshold and never proposes configured, unresolved, or protected accounts", () => {
    const twoSeeds = discoverFromPages(pages, { seeds, configuredIds: new Set(), configuredHandles: new Set(), minSeeds: 2 });
    expect(twoSeeds).toEqual([]);

    const all = discoverFromPages(pages, { seeds, configuredIds: new Set(["300"]), configuredHandles: new Set(), minSeeds: 1 });
    const base = { version: 2, source: "fxtwitter", accounts: [] } as unknown as PilotConfig;
    const proposed = proposeConfig(base, all);
    const handles = proposed.accounts.map((account) => account.handle);
    expect(handles).not.toContain("quoted"); // configured by id
    expect(handles).not.toContain("friend"); // unresolved
    expect(handles).toContain("original");
    expect(proposed.accounts.every((account) => account.cohort === "guest")).toBe(true);
  });

  it("resolves handle-only candidates through the profile endpoint and reports not-found ones", async () => {
    const candidates = discoverFromPages(pages, { seeds, configuredIds: new Set(), configuredHandles: new Set(), minSeeds: 1 });
    const requested: string[] = [];
    const client: PilotClient = {
      async fetchProfile(handle) {
        requested.push(handle);
        if (handle === "friend") return profile("777", "Friend", 42, 900);
        return { httpStatus: 404, latencyMs: 1, attempts: 1, receivedAt: 0, raw: null, profile: null };
      },
      async fetchTimelinePage() {
        throw new Error("not used");
      },
    };
    await resolveCandidates(candidates, client, async () => undefined);
    expect(requested).toEqual(["friend"]);
    const friend = candidates.find((candidate) => candidate.handle === "friend");
    expect(friend).toMatchObject({ userId: "777", resolution: "resolved", followers: 42, statuses: 900 });
    const markdown = renderMarkdown(candidates, 1, ["test"]);
    expect(markdown).toContain("| `friend` | `777` |");
    expect(candidates.some((candidate) => candidate.resolution === "not_found")).toBe(false);
    expect(markdown).toContain("| `quoted` | `300` |");
    expect(markdown).toContain("| `friend` | `777` | 1 | 1 |");
  });
});

function profile(id: string, screenName: string, followers: number, statuses: number): ProfileResponse {
  return {
    httpStatus: 200,
    latencyMs: 1,
    attempts: 1,
    receivedAt: 0,
    raw: { code: 200, user: { id, screen_name: screenName, name: screenName, followers, statuses, protected: false } },
    profile: { id, screenName, name: screenName, protected: false },
  };
}

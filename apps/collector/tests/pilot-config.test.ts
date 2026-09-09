import { describe, expect, it } from "vitest";
import pilotJson from "../../../config/collection/pilot.json" with { type: "json" };
import { COHORTS, configHash, parsePilotConfig, selectAccounts } from "../src/config/pilot.ts";

const COHORT_SIZES: Partial<Record<(typeof COHORTS)[number], number>> = {
  origin: 2,
  core: 14,
  crew: 20,
  bigger: 24,
  org: 2,
};

describe("collection pilot configuration", () => {
  const pilot = parsePilotConfig(pilotJson);

  it("defines the approved 62-account graph-derived pilot", () => {
    expect(pilot.version).toBe(2);
    expect(pilot.source).toBe("fxtwitter");
    expect(pilot.apiBaseUrl).toBe("https://api.fxtwitter.com");
    expect(pilot.historyDays).toBe(183);
    expect(pilot.withReplies).toBe(true);
    expect(pilot.requestedPageSize).toBeLessThanOrEqual(100);
    expect(pilot.delayMs).toBeGreaterThanOrEqual(500);
    expect(pilot.coverageFloor).toBe(500);
    expect(pilot.selectedOn).toBe("2026-09-03");
    expect(pilot.accounts).toHaveLength(62);

    const counts: Record<string, number> = {};
    for (const account of pilot.accounts)
      counts[account.cohort] = (counts[account.cohort] ?? 0) + 1;
    expect(counts).toEqual(COHORT_SIZES);
  });

  it("pins every account to a numeric user id stored as a string", () => {
    for (const entry of pilotJson.accounts) {
      expect(typeof entry.expectedUserId).toBe("string");
      expect(entry.expectedUserId).toMatch(/^[0-9]+$/);
    }
    const ids = new Set(pilot.accounts.map((account) => account.expectedUserId));
    expect(ids.size).toBe(pilot.accounts.length);
  });

  it("does not configure the same handle twice", () => {
    const handles = pilot.accounts.map((account) => account.handle.toLowerCase());
    expect(new Set(handles).size).toBe(handles.length);
  });

  it("seeds theo, not the squatted t3dotgg placeholder, and both origin accounts", () => {
    const handles = pilot.accounts.map((account) => account.handle.toLowerCase());
    expect(handles).toContain("theo");
    expect(handles).not.toContain("t3dotgg");
    expect(
      pilot.accounts
        .filter((account) => account.cohort === "origin")
        .map((account) => account.handle),
    ).toEqual(["notpronsh", "pcstyle53"]);
    expect(pilot.accounts.find((account) => account.handle === "theo")?.expectedUserId).toBe(
      "786375418685165568",
    );
  });

  it.each([
    {
      name: "numeric id",
      accounts: [{ handle: "theo", expectedUserId: 1, cohort: "core" }],
      error: /numeric string/,
    },
    {
      name: "unknown cohort",
      accounts: [{ handle: "theo", expectedUserId: "1", cohort: "hub" }],
      error: /cohort/,
    },
    {
      name: "duplicate handle",
      accounts: [
        { handle: "theo", expectedUserId: "1", cohort: "core" },
        { handle: "theo", expectedUserId: "2", cohort: "core" },
      ],
      error: /duplicate handle/,
    },
    {
      name: "duplicate handle case-insensitive",
      accounts: [
        { handle: "theo", expectedUserId: "1", cohort: "core" },
        { handle: "Theo", expectedUserId: "2", cohort: "core" },
      ],
      error: /duplicate handle/,
    },
    {
      name: "duplicate id",
      accounts: [
        { handle: "theo", expectedUserId: "1", cohort: "core" },
        { handle: "other", expectedUserId: "1", cohort: "core" },
      ],
      error: /duplicate/,
    },
  ])("rejects $name", ({ accounts, error }) => {
    const base = {
      ...pilotJson,
      accounts: [{ handle: "theo", expectedUserId: "1", cohort: "core" }],
    };
    expect(() => parsePilotConfig({ ...base, accounts })).toThrow(error);
  });

  it.each([
    { input: ["AMPCODE", "theo"], expected: ["theo", "ampcode"] },
    { input: ["theo", "AMPCODE"], expected: ["theo", "ampcode"] },
    { input: ["Theo"], expected: ["theo"] },
  ])("selects accounts case-insensitively in config order ($input)", ({ input, expected }) => {
    expect(selectAccounts(pilot, input).accounts.map((account) => account.handle)).toEqual(
      expected,
    );
  });

  it("hashes selections canonically and rejects unknown handles", () => {
    const selected = selectAccounts(pilot, ["AMPCODE", "theo"]);
    expect(() => selectAccounts(pilot, ["nobody_here"])).toThrow(/not in pilot config/);
    expect(configHash(selected)).toHaveLength(64);
    expect(configHash(selected)).not.toBe(configHash(pilot));
  });
});

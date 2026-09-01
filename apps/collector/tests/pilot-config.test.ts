import { describe, expect, it } from "vitest";
import pilot from "../../../config/collection/pilot.json" with { type: "json" };

describe("collection pilot configuration", () => {
  it("defines the approved core milestone and bonus accounts", () => {
    expect(pilot.version).toBe(1);
    expect(pilot.source).toBe("fxtwitter");
    expect(pilot.historyDays).toBe(183);
    expect(pilot.withReplies).toBe(true);
    expect(pilot.requestedPageSize).toBeGreaterThanOrEqual(1);
    expect(pilot.requestedPageSize).toBeLessThanOrEqual(100);

    expect(pilot.coreAccounts).toHaveLength(10);
    expect(
      pilot.coreAccounts.reduce(
        (total, account) => total + account.authoredTweetTarget,
        0,
      ),
    ).toBe(5_000);
    expect(pilot.bonusAccounts.map((account) => account.handle)).toEqual([
      "notpronsh",
      "pcstyle53",
    ]);
  });

  it("does not configure the same handle twice", () => {
    const handles = [...pilot.coreAccounts, ...pilot.bonusAccounts].map((account) =>
      account.handle.toLowerCase(),
    );
    expect(new Set(handles).size).toBe(handles.length);
  });
});

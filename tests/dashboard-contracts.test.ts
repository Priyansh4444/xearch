// Contract-consistency guard: apps/dashboard/src/index.ts mirrors AccountState
// and AcquisitionStatus as Effect-free copies (the worker bundle cannot import
// the collector). If either side drifts, search filtering and the dashboard
// disagree about what states exist. This test fails on any divergence.
//
// The dashboard entry imports worker/DOM code at module scope, so it cannot be
// imported in node — instead the mirrored literals are extracted from source
// and compared against the collector contracts value-for-value.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  AccountState,
  AcquisitionStatus,
} from "../apps/collector/src/contracts/run-state.ts";

const DASHBOARD_INDEX = fileURLToPath(
  new URL("../apps/dashboard/src/index.ts", import.meta.url),
);

function mirroredValues(source: string, constName: string): Record<string, string> {
  const block = new RegExp(`export const ${constName} = \\{([^}]*)\\}`).exec(source)?.[1];
  if (block === undefined) throw new Error(`dashboard no longer mirrors ${constName}`);
  const entries = [...block.matchAll(/(\w+): "([^"]+)"/g)].map((m) => [m[1]!, m[2]!] as const);
  if (entries.length === 0) throw new Error(`could not parse mirrored ${constName}`);
  return Object.fromEntries(entries);
}

describe("dashboard contract mirror", () => {
  test("AccountState and AcquisitionStatus match the collector exactly", async () => {
    const source = await readFile(DASHBOARD_INDEX, "utf8");
    expect(mirroredValues(source, "AccountState")).toEqual({ ...AccountState });
    expect(mirroredValues(source, "AcquisitionStatus")).toEqual({ ...AcquisitionStatus });
  });
});

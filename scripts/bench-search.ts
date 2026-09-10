// Read-only deployed-query observations. See docs/SEARCH-BENCHMARK.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseQueries, positiveInteger, summarize, validateResponse } from "./bench-search-lib.ts";

const url = process.env["CONVEX_URL"];
if (url === undefined || url === "")
  throw new Error("Set CONVEX_URL to the deployment to observe.");
const allowed = new Set(["--runs", "--limit"]);
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!flag || !allowed.has(flag) || !value || flags.has(flag))
    throw new Error("Usage: pnpm bench:search [--runs 2] [--limit 4]");
  flags.set(flag, value);
}
const runs = positiveInteger(flags.get("--runs") ?? "2");
const limit = positiveInteger(flags.get("--limit") ?? "4");
const fixtureBytes = readFileSync(
  new URL("../shared/fixtures/bench-queries.json", import.meta.url),
  "utf8",
);
const queries = parseQueries(JSON.parse(fixtureBytes)).slice(0, limit);
if (queries.length * runs > 100) throw new Error("At most 100 requests per invocation.");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).length > 0;
const samples = [];
let failures = 0;
for (const query of queries) {
  for (let run = 0; run < runs; run++) {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    try {
      // Only /api/query. No action, mutation, cache-busting, or automatic retry.
      const response = await fetch(new URL("/api/query", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "search:search",
          args: { raw: query.raw, sort: "top" },
          format: "json",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      const clientMs = performance.now() - start;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = validateResponse(JSON.parse(text));
      const floorMet = value.error === null && value.ids.length >= query.minResults;
      if (!floorMet) failures++;
      samples.push({
        raw: query.raw,
        run,
        phase: run === 0 ? "first-observed" : "repeat",
        startedAt,
        clientMs,
        serverMs: null,
        cacheStatus: "unknown",
        responseSha256: sha256(text),
        floorMet,
        minResults: query.minResults,
        ...value,
      });
    } catch (error) {
      failures++;
      samples.push({ raw: query.raw, run, startedAt, failure: String(error) });
    }
  }
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      deploymentUrl: url,
      deployedRevision: null,
      localRevision: revision,
      localDirty: dirty,
      node: process.version,
      fixtureSha256: sha256(fixtureBytes),
      localLexiconSha256: sha256(
        readFileSync(new URL("../shared/lexicons/aspects.json", import.meta.url), "utf8"),
      ),
      deployedConfigHash: null,
      config: {
        path: "search:search",
        sort: "top",
        runs,
        queryLimit: limit,
        warmups: 0,
        retries: 0,
        timeoutMs: 30_000,
      },
      timing: "HTTP request through response body; client-observed, not server execution",
      firstObserved: summarize(
        samples.flatMap((s) =>
          "clientMs" in s && s.phase === "first-observed" ? [s.clientMs] : [],
        ),
      ),
      repeat: summarize(
        samples.flatMap((s) => ("clientMs" in s && s.phase === "repeat" ? [s.clientMs] : [])),
      ),
      samples,
      failures,
    },
    null,
    2,
  ),
);
if (failures > 0) process.exitCode = 1;

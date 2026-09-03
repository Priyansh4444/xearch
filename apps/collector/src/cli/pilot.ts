import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FxTwitterClient } from "../acquisition/fxtwitter.ts";
import { loadPilotConfig, selectAccounts, type PilotConfig } from "../config/pilot.ts";
import { readRunPages, type RawPageInput } from "../normalization/normalize.ts";
import { acquire, createRun } from "../pilot/acquire.ts";
import { discoverFromPages, proposeConfig, renderMarkdown, resolveCandidates } from "../pilot/discover.ts";
import { createRunId, fileExists, isValidRunId, readJson, runPaths, writeJsonAtomic, writeTextAtomic, type RunPaths } from "../pilot/layout.ts";
import {
  abandonAccount,
  abandonRun,
  loadRunConfig,
  locateRun,
  normalizeAndArchive,
  reopenAccount,
  verifyArchive,
} from "../pilot/lifecycle.ts";
import type { Manifest } from "../pilot/manifest.ts";
import type { PilotReport } from "../pilot/report.ts";

const DEFAULT_CONFIG = "config/collection/pilot.json";
const DEFAULT_DATA_DIR = "data";

interface Flags {
  positional: string[];
  options: Map<string, string>;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const dataDir = resolve(flags.options.get("data-dir") ?? DEFAULT_DATA_DIR);

  switch (command) {
    case "acquire":
      return acquireCommand(flags, dataDir);
    case "normalize":
      return normalizeCommand(flags, dataDir);
    case "verify":
      return verifyCommand(flags, dataDir);
    case "abandon-account":
      return abandonAccountCommand(flags, dataDir);
    case "reopen-account":
      return reopenAccountCommand(flags, dataDir);
    case "abandon":
      return abandonRunCommand(flags, dataDir);
    case "status":
      return statusCommand(flags, dataDir);
    case "discover":
      return discoverCommand(flags, dataDir);
    default:
      usage(command === undefined ? "A command is required." : `Unknown command: ${command}`);
  }
}

async function acquireCommand(flags: Flags, dataDir: string): Promise<void> {
  const requestedRunId = flags.options.get("run") ?? null;
  let paths: RunPaths;
  let config: PilotConfig;

  if (requestedRunId !== null && (await fileExists(runPaths(dataDir, "runs", requestedRunId).manifest))) {
    if (flags.options.has("accounts") || flags.options.has("config")) {
      usage("--accounts and --config cannot change an existing run; start a new run instead.");
    }
    paths = runPaths(dataDir, "runs", requestedRunId);
    const snapshot = await loadRunConfig(paths);
    if (snapshot === null) throw new Error(`run ${requestedRunId} has no config snapshot`);
    config = snapshot;
    console.log(`resuming run ${requestedRunId}`);
  } else {
    if (requestedRunId !== null && !isValidRunId(requestedRunId)) usage(`Invalid run id: ${requestedRunId}`);
    if (requestedRunId !== null && (await locateRun(dataDir, requestedRunId)) !== null) {
      throw new Error(`run ${requestedRunId} is archived and cannot be resumed`);
    }
    const loaded = await loadPilotConfig(resolve(flags.options.get("config") ?? DEFAULT_CONFIG));
    const accounts = flags.options.get("accounts")?.split(",").map((handle) => handle.trim()).filter(Boolean) ?? null;
    config = selectAccounts(loaded, accounts);
    const runId = requestedRunId ?? createRunId(new Date(), flags.options.get("label") ?? "pilot");
    paths = runPaths(dataDir, "runs", runId);
    await createRun(paths, config, runId, Date.now());
    console.log(`created run ${runId} with ${config.accounts.length} account(s)`);
  }

  const client = new FxTwitterClient({
    baseUrl: config.apiBaseUrl,
    timeoutMs: integerOption(flags, "timeout-ms", 15_000),
    retries: integerOption(flags, "retries", 3),
  });
  const maxRequests = flags.options.has("max-requests") ? integerOption(flags, "max-requests", 0) : undefined;
  const manifest = await acquire({ paths, config, client, log: (line) => console.log(line), maxRequests });
  printAcquisition(manifest, paths);
}

async function normalizeCommand(flags: Flags, dataDir: string): Promise<void> {
  const runId = requireRunId(flags);
  const located = await locateRun(dataDir, runId);
  if (located === null) throw new Error(`run ${runId} not found under ${dataDir}`);
  if (located.archived) throw new Error(`run ${runId} is already archived; use verify`);
  const config = await loadRunConfig(located.paths);
  if (config === null) throw new Error(`run ${runId} has no config snapshot`);

  const result = await normalizeAndArchive({ dataDir, paths: located.paths, config, log: (line) => console.log(line) });
  const report = await readJson<PilotReport>(result.archivedPaths.report);
  printReport(report);
  console.log(`manifest: ${result.archivedPaths.manifest}`);
  console.log(`acceptance: ${result.manifest.acceptance.passed ? "passed" : `not passed (${result.manifest.acceptance.reasons.join("; ")})`}`);
}

async function verifyCommand(flags: Flags, dataDir: string): Promise<void> {
  const runId = requireRunId(flags);
  const located = await locateRun(dataDir, runId);
  if (located === null) throw new Error(`run ${runId} not found under ${dataDir}`);
  if (!located.archived) throw new Error(`run ${runId} is not archived yet; normalize it first`);
  const config = await loadRunConfig(located.paths);
  if (config === null) throw new Error(`run ${runId} has no config snapshot`);

  const scratch = await mkdtemp(join(tmpdir(), "xearch-verify-"));
  try {
    const result = await verifyArchive(located.paths, scratch, config);
    console.log(`verify ${runId}: ${result.hashesChecked} file hash(es) checked, ${result.hashMismatches.length} mismatch(es)`);
    console.log(`verify ${runId}: ${result.outputsCompared.length} output file(s) re-normalized, ${result.outputsDiffering.length} differ`);
    for (const path of result.hashMismatches) console.log(`  hash mismatch: ${path}`);
    for (const path of result.outputsDiffering) console.log(`  bytes differ: ${path}`);
    console.log(`verify ${runId}: ${result.passed ? "PASSED" : "FAILED"}`);
    if (!result.passed) process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function abandonAccountCommand(flags: Flags, dataDir: string): Promise<void> {
  const runId = requireRunId(flags);
  const handle = flags.positional[1];
  const reason = flags.options.get("reason");
  if (handle === undefined) usage("A handle is required.");
  if (reason === undefined || reason.trim().length === 0) usage("--reason is required.");
  const { paths, config } = await activeRun(dataDir, runId);
  const manifest = await abandonAccount({ dataDir, paths, config }, handle, reason);
  console.log(`abandoned @${handle} in run ${runId}; acquisition is now ${manifest.acquisition.status}`);
}

async function reopenAccountCommand(flags: Flags, dataDir: string): Promise<void> {
  const runId = requireRunId(flags);
  const handle = flags.positional[1];
  const reason = flags.options.get("reason");
  if (handle === undefined) usage("A handle is required.");
  if (reason === undefined || reason.trim().length === 0) usage("--reason is required.");
  const { paths, config } = await activeRun(dataDir, runId);
  const manifest = await reopenAccount({ dataDir, paths, config }, handle, reason);
  console.log(`reopened @${handle} in run ${runId}; acquisition is now ${manifest.acquisition.status}`);
}

async function abandonRunCommand(flags: Flags, dataDir: string): Promise<void> {
  const runId = requireRunId(flags);
  const reason = flags.options.get("reason");
  if (reason === undefined || reason.trim().length === 0) usage("--reason is required.");
  const { paths, config } = await activeRun(dataDir, runId);
  const archived = await abandonRun({ dataDir, paths, config }, reason);
  console.log(`run ${runId} abandoned and archived at ${archived.root}`);
}

async function statusCommand(flags: Flags, dataDir: string): Promise<void> {
  const runId = requireRunId(flags);
  const located = await locateRun(dataDir, runId);
  if (located === null) throw new Error(`run ${runId} not found under ${dataDir}`);
  const manifest = await readJson<Manifest>(located.paths.manifest);
  printAcquisition(manifest, located.paths);
  if (await fileExists(located.paths.report)) printReport(await readJson<PilotReport>(located.paths.report));
}

async function discoverCommand(flags: Flags, dataDir: string): Promise<void> {
  if (flags.positional.length === 0) usage("At least one run id is required.");
  const minSeeds = integerOption(flags, "min-seeds", 3);
  const pages: RawPageInput[] = [];
  const seeds = new Map<string, { userId: string; handle: string }>();
  let baseConfig: PilotConfig | null = null;
  for (const runId of flags.positional) {
    const located = await locateRun(dataDir, runId);
    if (located === null) throw new Error(`run ${runId} not found under ${dataDir}`);
    const config = await loadRunConfig(located.paths);
    if (config === null) throw new Error(`run ${runId} has no config snapshot`);
    baseConfig ??= config;
    const manifest = await readJson<Manifest>(located.paths.manifest);
    for (const account of manifest.acquisition.accounts) {
      if (account.userId !== null) seeds.set(account.userId, { userId: account.userId, handle: (account.resolvedHandle ?? account.requestedHandle).toLowerCase() });
    }
    pages.push(...(await readRunPages(located.paths, manifest)));
    console.log(`${runId}: ${pages.length} page(s) loaded so far`);
  }
  const configured = await loadPilotConfig(resolve(flags.options.get("config") ?? DEFAULT_CONFIG));
  const candidates = discoverFromPages(pages, {
    seeds: [...seeds.values()],
    configuredIds: new Set(configured.accounts.map((account) => account.expectedUserId)),
    configuredHandles: new Set(configured.accounts.map((account) => account.handle.toLowerCase())),
    minSeeds,
  });
  console.log(`${candidates.length} candidate(s) with >= ${minSeeds} distinct seeds`);

  if (flags.options.has("resolve")) {
    const client = new FxTwitterClient({ baseUrl: configured.apiBaseUrl });
    let first = true;
    const pace = async (): Promise<void> => {
      if (!first) await new Promise((done) => setTimeout(done, configured.delayMs));
      first = false;
    };
    const unresolved = candidates.filter((candidate) => candidate.resolution === "unresolved").length;
    console.log(`resolving ${unresolved} handle-only candidate(s) at ${configured.delayMs} ms pacing`);
    await resolveCandidates(candidates, client, pace, (line) => console.log(line));
  }

  const outDir = resolve(flags.options.get("out") ?? join(dataDir, "discovery", flags.positional.join("+")));
  await writeJsonAtomic(join(outDir, "report.json"), {
    generatedAt: Date.now(),
    sourceRuns: flags.positional,
    minSeeds,
    seeds: [...seeds.values()],
    candidates,
  });
  await writeTextAtomic(join(outDir, "report.md"), renderMarkdown(candidates, minSeeds, flags.positional));
  const proposed = proposeConfig({ ...(baseConfig as PilotConfig), selectedOn: new Date().toISOString().slice(0, 10) }, candidates);
  await writeJsonAtomic(join(outDir, "proposed-config.json"), proposed);
  console.log(`report: ${join(outDir, "report.md")}`);
  console.log(`proposed gate-2 config with ${proposed.accounts.length} guest account(s): ${join(outDir, "proposed-config.json")}`);
  console.log(`unresolved (need --resolve): ${candidates.filter((candidate) => candidate.resolution === "unresolved").length}`);
}

async function activeRun(dataDir: string, runId: string): Promise<{ paths: RunPaths; config: PilotConfig }> {
  const located = await locateRun(dataDir, runId);
  if (located === null) throw new Error(`run ${runId} not found under ${dataDir}`);
  if (located.archived) throw new Error(`run ${runId} is archived and immutable`);
  const config = await loadRunConfig(located.paths);
  if (config === null) throw new Error(`run ${runId} has no config snapshot`);
  return { paths: located.paths, config };
}

function printAcquisition(manifest: Manifest, paths: RunPaths): void {
  console.log(`run ${manifest.runId}: acquisition ${manifest.acquisition.status}${manifest.archive ? " (archived)" : ""}`);
  for (const account of manifest.acquisition.accounts) {
    const detail =
      account.state === "completed"
        ? account.stopReason
        : account.state === "paused"
          ? `${account.pauseReason}: ${account.lastError ?? ""}`
          : account.state === "abandoned"
            ? account.abandonReason
            : "";
    console.log(
      `  @${account.requestedHandle.padEnd(16)} ${account.state.padEnd(9)} pages=${String(account.pagesCompleted).padStart(4)} rows=${String(account.rowsReturned).padStart(6)} ${detail ?? ""}`,
    );
  }
  const paused = manifest.acquisition.accounts.filter((account) => account.state === "paused");
  if (paused.length > 0) {
    console.log(`${paused.length} account(s) paused; re-run acquire to retry or abandon-account to give up`);
  }
  console.log(`checkpoint: ${paths.checkpoint}`);
}

function printReport(report: PilotReport): void {
  const counts = report.normalization;
  if (counts !== null) {
    console.log(
      `normalization: ${counts.accepted.total} accepted (${counts.accepted.timeline} timeline, ${counts.accepted.embedded} embedded), ${counts.rejected.total} rejected, ${counts.duplicates} duplicates, ${counts.skippedOutsideWindow} outside window, ${counts.authors} authors`,
    );
    console.log(`rejections by reason: ${JSON.stringify(counts.rejected.byReason)}`);
    console.log(`coverage floor ${report.coverage.floor}: ${report.coverage.accountsReached}/${report.coverage.accountsTotal} account(s)`);
    if (report.authorShare.topHandle !== null) {
      console.log(`top author share: @${report.authorShare.topHandle} ${(100 * (report.authorShare.topShare ?? 0)).toFixed(1)}%`);
    }
  }
  const requests = report.acquisition.requests;
  console.log(
    `requests: ${requests.total} (${requests.retries} retries), latency mean ${fmt(requests.latencyMs.mean)} ms p95 ${fmt(requests.latencyMs.p95)} ms, rows/page mean ${fmt(requests.rowsPerPage.mean)}`,
  );
  console.log(`thresholds: ${report.thresholds.passed ? "passed" : "NOT passed"}`);
  for (const check of report.thresholds.checks) {
    const mark = check.passed === null ? "-" : check.passed ? "ok" : "FAIL";
    console.log(`  [${mark.padEnd(4)}] ${check.name}: ${check.value === null ? "n/a" : String(check.value)} (bound ${check.bound})`);
  }
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value * 10) / 10);
}

function requireRunId(flags: Flags): string {
  const runId = flags.positional[0];
  if (runId === undefined) usage("A run id is required.");
  return runId;
}

function integerOption(flags: Flags, name: string, fallback: number): number {
  const value = flags.options.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) usage(`--${name} must be a non-negative integer.`);
  return parsed;
}

function parseFlags(args: string[]): Flags {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) options.set(key as string, inline);
      else {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) usage(`Missing value for --${key}.`);
        options.set(key as string, next);
        index += 1;
      }
    } else positional.push(arg);
  }
  return { positional, options };
}

function usage(message: string): never {
  console.error(message);
  console.error(`Usage:
  pnpm collect:pilot acquire [--run <id>] [--accounts a,b] [--label smoke] [--config ${DEFAULT_CONFIG}] [--data-dir ${DEFAULT_DATA_DIR}] [--max-requests n]
  pnpm collect:pilot normalize <run-id>
  pnpm collect:pilot verify <run-id>
  pnpm collect:pilot status <run-id>
  pnpm collect:pilot discover <run-id> [<run-id>...] [--min-seeds 3] [--resolve] [--out dir]
  pnpm collect:pilot abandon-account <run-id> <handle> --reason "..."
  pnpm collect:pilot reopen-account <run-id> <handle> --reason "..."
  pnpm collect:pilot abandon <run-id> --reason "..."`);
  process.exit(2);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

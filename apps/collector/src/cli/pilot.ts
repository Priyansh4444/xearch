import { posixPath } from "../contracts/posixPath.ts";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CollectorRuntime } from "../contracts/runtime.ts";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { FxTwitterError, makeFxTwitterClient } from "../acquisition/fxtwitter.ts";
import {
  loadPilotConfigEffect,
  selectAccountsEffect,
  type PilotConfig,
  PilotConfigError,
} from "../config/pilot.ts";
import {
  fileExistsEffect,
  readJsonEffect,
  writeJsonAtomicEffect,
  writeTextAtomicEffect,
  type FsError,
} from "../contracts/fs.ts";
import { AccountState, DiscoveryResolution } from "../contracts/run-state.ts";
import { readRunPagesEffect, type RawPageInput } from "../normalization/normalize.ts";
import { acquireEffect, createRunEffect } from "../pilot/acquire.ts";
import {
  discoverFromPages,
  proposeConfig,
  renderMarkdown,
  resolveCandidatesEffect,
} from "../pilot/discover.ts";
import { createRunId, isValidRunId, runPaths, type RunPaths } from "../pilot/layout.ts";
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

const logLine = (line: string): void => Effect.runSync(Console.log(line));

const DEFAULT_CONFIG = "config/collection/pilot.json";
const DEFAULT_DATA_DIR = "data";
const USAGE = `Usage:
  pnpm collect:pilot acquire [--run <id>] [--accounts a,b] [--label smoke] [--config ${DEFAULT_CONFIG}] [--data-dir ${DEFAULT_DATA_DIR}] [--max-requests n]
  pnpm collect:pilot normalize <run-id>
  pnpm collect:pilot verify <run-id>
  pnpm collect:pilot status <run-id>
  pnpm collect:pilot discover <run-id> [<run-id>...] [--min-seeds 3] [--resolve] [--out dir]
  pnpm collect:pilot abandon-account <run-id> <handle> --reason "..."
  pnpm collect:pilot reopen-account <run-id> <handle> --reason "..."
  pnpm collect:pilot abandon <run-id> --reason "..."`;

const PilotCommand = {
  acquire: "acquire",
  normalize: "normalize",
  verify: "verify",
  abandonAccount: "abandon-account",
  reopenAccount: "reopen-account",
  abandon: "abandon",
  status: "status",
  discover: "discover",
} as const;

export class PilotCliError extends Data.TaggedError("PilotCliError")<{
  readonly message: string;
  readonly exitCode: number;
}> {}

interface Flags {
  positional: string[];
  options: Map<string, string>;
}

type CliError = PilotCliError | PilotConfigError | FsError | FxTwitterError | Error;

const main = Effect.fn("pilot.main")(function* (): Effect.fn.Return<
  void,
  CliError,
  FileSystem.FileSystem
> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = yield* parseFlagsEffect(rest);
  const dataDir = posixPath.resolve(flags.options.get("data-dir") ?? DEFAULT_DATA_DIR);

  switch (command) {
    case PilotCommand.acquire:
      return yield* acquireCommand(flags, dataDir);
    case PilotCommand.normalize:
      return yield* normalizeCommand(flags, dataDir);
    case PilotCommand.verify:
      return yield* verifyCommand(flags, dataDir);
    case PilotCommand.abandonAccount:
      return yield* abandonAccountCommand(flags, dataDir);
    case PilotCommand.reopenAccount:
      return yield* reopenAccountCommand(flags, dataDir);
    case PilotCommand.abandon:
      return yield* abandonRunCommand(flags, dataDir);
    case PilotCommand.status:
      return yield* statusCommand(flags, dataDir);
    case PilotCommand.discover:
      return yield* discoverCommand(flags, dataDir);
    default:
      return yield* usageFail(
        command === undefined ? "A command is required." : `Unknown command: ${command}`,
      );
  }
});

const acquireCommand = Effect.fn("pilot.acquire")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  const requestedRunId = flags.options.get("run") ?? null;
  let paths: RunPaths;
  let config: PilotConfig;

  if (
    requestedRunId !== null &&
    (yield* fileExistsEffect(runPaths(dataDir, "runs", requestedRunId).manifest))
  ) {
    if (flags.options.has("accounts") || flags.options.has("config")) {
      return yield* usageFail(
        "--accounts and --config cannot change an existing run; start a new run instead.",
      );
    }
    paths = runPaths(dataDir, "runs", requestedRunId);
    const snapshot = yield* tryPromise(loadRunConfig(paths));
    if (snapshot === null) {
      return yield* cliFail(`run ${requestedRunId} has no config snapshot`);
    }
    config = snapshot;
    yield* Console.log(`resuming run ${requestedRunId}`);
  } else {
    if (requestedRunId !== null && !isValidRunId(requestedRunId)) {
      return yield* usageFail(`Invalid run id: ${requestedRunId}`);
    }
    if (requestedRunId !== null) {
      const located = yield* tryPromise(locateRun(dataDir, requestedRunId));
      if (located !== null) {
        return yield* cliFail(`run ${requestedRunId} is archived and cannot be resumed`);
      }
    }
    const loaded = yield* loadPilotConfigEffect(
      posixPath.resolve(flags.options.get("config") ?? DEFAULT_CONFIG),
    );
    const accounts =
      flags.options
        .get("accounts")
        ?.split(",")
        .map((handle) => handle.trim())
        .filter(Boolean) ?? null;
    config = yield* selectAccountsEffect(loaded, accounts);
    const runId =
      requestedRunId ??
      createRunId(DateTime.toDate(yield* DateTime.now), flags.options.get("label") ?? "pilot");
    paths = runPaths(dataDir, "runs", runId);
    yield* createRunEffect(paths, config, runId, yield* Clock.currentTimeMillis);
    yield* Console.log(`created run ${runId} with ${config.accounts.length} account(s)`);
  }

  const client = makeFxTwitterClient({
    baseUrl: config.apiBaseUrl,
    timeoutMs: yield* integerOptionEffect(flags, "timeout-ms", 15_000),
    retries: yield* integerOptionEffect(flags, "retries", 3),
  });
  const maxRequests = flags.options.has("max-requests")
    ? yield* integerOptionEffect(flags, "max-requests", 0)
    : undefined;
  const manifest = yield* acquireEffect({
    paths,
    config,
    client,
    log: logLine,
    maxRequests,
  });
  yield* printAcquisition(manifest, paths);
});

const normalizeCommand = Effect.fn("pilot.normalize")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  const runId = yield* requireRunId(flags);
  const located = yield* tryPromise(locateRun(dataDir, runId));
  if (located === null) return yield* cliFail(`run ${runId} not found under ${dataDir}`);
  if (located.archived) return yield* cliFail(`run ${runId} is already archived; use verify`);
  const config = yield* tryPromise(loadRunConfig(located.paths));
  if (config === null) return yield* cliFail(`run ${runId} has no config snapshot`);

  const result = yield* tryPromise(
    normalizeAndArchive({
      dataDir,
      paths: located.paths,
      config,
      log: logLine,
    }),
  );
  const report = (yield* readJsonEffect(result.archivedPaths.report)) as PilotReport;
  yield* printReport(report);
  yield* Console.log(`manifest: ${result.archivedPaths.manifest}`);
  yield* Console.log(
    `acceptance: ${result.manifest.acceptance.passed ? "passed" : `not passed (${result.manifest.acceptance.reasons.join("; ")})`}`,
  );
});

const verifyCommand = Effect.fn("pilot.verify")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  const runId = yield* requireRunId(flags);
  const located = yield* tryPromise(locateRun(dataDir, runId));
  if (located === null) return yield* cliFail(`run ${runId} not found under ${dataDir}`);
  if (!located.archived)
    return yield* cliFail(`run ${runId} is not archived yet; normalize it first`);
  const config = yield* tryPromise(loadRunConfig(located.paths));
  if (config === null) return yield* cliFail(`run ${runId} has no config snapshot`);

  const fs = yield* FileSystem.FileSystem;
  const scratch = yield* fs.makeTempDirectory({ prefix: "xearch-verify-" });
  const result = yield* tryPromise(verifyArchive(located.paths, scratch, config)).pipe(
    Effect.ensuring(fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.orDie)),
  );
  yield* Console.log(
    `verify ${runId}: ${result.hashesChecked} file hash(es) checked, ${result.hashMismatches.length} mismatch(es)`,
  );
  yield* Console.log(
    `verify ${runId}: ${result.outputsCompared.length} output file(s) re-normalized, ${result.outputsDiffering.length} differ`,
  );
  for (const path of result.hashMismatches) yield* Console.log(`  hash mismatch: ${path}`);
  for (const path of result.outputsDiffering) yield* Console.log(`  bytes differ: ${path}`);
  yield* Console.log(`verify ${runId}: ${result.passed ? "PASSED" : "FAILED"}`);
  if (!result.passed) process.exitCode = 1;
});

const abandonAccountCommand = Effect.fn("pilot.abandonAccount")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  const runId = yield* requireRunId(flags);
  const handle = flags.positional[1];
  const reason = flags.options.get("reason");
  if (handle === undefined) return yield* usageFail("A handle is required.");
  if (reason === undefined || reason.trim().length === 0)
    return yield* usageFail("--reason is required.");
  const { paths, config } = yield* activeRun(dataDir, runId);
  const manifest = yield* tryPromise(abandonAccount({ dataDir, paths, config }, handle, reason));
  yield* Console.log(
    `abandoned @${handle} in run ${runId}; acquisition is now ${manifest.acquisition.status}`,
  );
});

const reopenAccountCommand = Effect.fn("pilot.reopenAccount")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  const runId = yield* requireRunId(flags);
  const handle = flags.positional[1];
  const reason = flags.options.get("reason");
  if (handle === undefined) return yield* usageFail("A handle is required.");
  if (reason === undefined || reason.trim().length === 0)
    return yield* usageFail("--reason is required.");
  const { paths, config } = yield* activeRun(dataDir, runId);
  const manifest = yield* tryPromise(reopenAccount({ dataDir, paths, config }, handle, reason));
  yield* Console.log(
    `reopened @${handle} in run ${runId}; acquisition is now ${manifest.acquisition.status}`,
  );
});

const abandonRunCommand = Effect.fn("pilot.abandon")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  const runId = yield* requireRunId(flags);
  const reason = flags.options.get("reason");
  if (reason === undefined || reason.trim().length === 0)
    return yield* usageFail("--reason is required.");
  const { paths, config } = yield* activeRun(dataDir, runId);
  const archived = yield* tryPromise(abandonRun({ dataDir, paths, config }, reason));
  yield* Console.log(`run ${runId} abandoned and archived at ${archived.root}`);
});

const statusCommand = Effect.fn("pilot.status")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  const runId = yield* requireRunId(flags);
  const located = yield* tryPromise(locateRun(dataDir, runId));
  if (located === null) return yield* cliFail(`run ${runId} not found under ${dataDir}`);
  const manifest = (yield* readJsonEffect(located.paths.manifest)) as Manifest;
  yield* printAcquisition(manifest, located.paths);
  if (yield* fileExistsEffect(located.paths.report)) {
    yield* printReport((yield* readJsonEffect(located.paths.report)) as PilotReport);
  }
});

const discoverCommand = Effect.fn("pilot.discover")(function* (
  flags: Flags,
  dataDir: string,
): Effect.fn.Return<void, CliError, FileSystem.FileSystem> {
  if (flags.positional.length === 0) return yield* usageFail("At least one run id is required.");
  const minSeeds = yield* integerOptionEffect(flags, "min-seeds", 3);
  const pages: RawPageInput[] = [];
  const seeds = new Map<string, { userId: string; handle: string }>();
  let baseConfig: PilotConfig | null = null;
  for (const runId of flags.positional) {
    const located = yield* tryPromise(locateRun(dataDir, runId));
    if (located === null) return yield* cliFail(`run ${runId} not found under ${dataDir}`);
    const config = yield* tryPromise(loadRunConfig(located.paths));
    if (config === null) return yield* cliFail(`run ${runId} has no config snapshot`);
    baseConfig ??= config;
    const manifest = (yield* readJsonEffect(located.paths.manifest)) as Manifest;
    for (const account of manifest.acquisition.accounts) {
      if (account.userId !== null) {
        seeds.set(account.userId, {
          userId: account.userId,
          handle: (account.resolvedHandle ?? account.requestedHandle).toLowerCase(),
        });
      }
    }
    pages.push(...(yield* readRunPagesEffect(located.paths, manifest)));
    yield* Console.log(`${runId}: ${pages.length} page(s) loaded so far`);
  }
  const configured = yield* loadPilotConfigEffect(
    posixPath.resolve(flags.options.get("config") ?? DEFAULT_CONFIG),
  );
  const candidates = discoverFromPages(pages, {
    seeds: [...seeds.values()],
    configuredIds: new Set(configured.accounts.map((account) => account.expectedUserId)),
    configuredHandles: new Set(configured.accounts.map((account) => account.handle.toLowerCase())),
    minSeeds,
  });
  yield* Console.log(`${candidates.length} candidate(s) with >= ${minSeeds} distinct seeds`);

  if (flags.options.has("resolve")) {
    const client = makeFxTwitterClient({ baseUrl: configured.apiBaseUrl });
    let first = true;
    const pace = Effect.fn("pilot.discover.pace")(function* (): Effect.fn.Return<void> {
      if (!first) yield* Effect.sleep(configured.delayMs);
      first = false;
    });
    const unresolved = candidates.filter(
      (candidate) => candidate.resolution === DiscoveryResolution.Unresolved,
    ).length;
    yield* Console.log(
      `resolving ${unresolved} handle-only candidate(s) at ${configured.delayMs} ms pacing`,
    );
    // resolveCandidatesEffect takes an Effect pace directly.
    yield* resolveCandidatesEffect(candidates, client, pace(), logLine);
  }

  const outDir = posixPath.resolve(
    flags.options.get("out") ?? posixPath.join(dataDir, "discovery", flags.positional.join("+")),
  );
  yield* writeJsonAtomicEffect(posixPath.join(outDir, "report.json"), {
    generatedAt: yield* Clock.currentTimeMillis,
    sourceRuns: flags.positional,
    minSeeds,
    seeds: [...seeds.values()],
    candidates,
  });
  yield* writeTextAtomicEffect(
    posixPath.join(outDir, "report.md"),
    renderMarkdown(candidates, minSeeds, flags.positional),
  );
  const proposed = proposeConfig(
    { ...(baseConfig as PilotConfig), selectedOn: DateTime.formatIsoDate(yield* DateTime.now) },
    candidates,
  );
  yield* writeJsonAtomicEffect(posixPath.join(outDir, "proposed-config.json"), proposed);
  yield* Console.log(`report: ${posixPath.join(outDir, "report.md")}`);
  yield* Console.log(
    `proposed gate-2 config with ${proposed.accounts.length} guest account(s): ${posixPath.join(outDir, "proposed-config.json")}`,
  );
  yield* Console.log(
    `unresolved (need --resolve): ${candidates.filter((candidate) => candidate.resolution === DiscoveryResolution.Unresolved).length}`,
  );
});

const activeRun = Effect.fn("pilot.activeRun")(function* (
  dataDir: string,
  runId: string,
): Effect.fn.Return<{ paths: RunPaths; config: PilotConfig }, CliError> {
  const located = yield* tryPromise(locateRun(dataDir, runId));
  if (located === null) return yield* cliFail(`run ${runId} not found under ${dataDir}`);
  if (located.archived) return yield* cliFail(`run ${runId} is archived and immutable`);
  const config = yield* tryPromise(loadRunConfig(located.paths));
  if (config === null) return yield* cliFail(`run ${runId} has no config snapshot`);
  return { paths: located.paths, config };
});

const printAcquisition = Effect.fn("pilot.printAcquisition")(function* (
  manifest: Manifest,
  paths: RunPaths,
): Effect.fn.Return<void> {
  yield* Console.log(
    `run ${manifest.runId}: acquisition ${manifest.acquisition.status}${manifest.archive !== null ? " (archived)" : ""}`,
  );
  for (const account of manifest.acquisition.accounts) {
    const detail =
      account.state === AccountState.Completed
        ? account.stopReason
        : account.state === AccountState.Paused
          ? `${account.pauseReason}: ${account.lastError ?? ""}`
          : account.state === AccountState.Abandoned
            ? account.abandonReason
            : "";
    yield* Console.log(
      `  @${account.requestedHandle.padEnd(16)} ${account.state.padEnd(9)} pages=${String(account.pagesCompleted).padStart(4)} rows=${String(account.rowsReturned).padStart(6)} ${detail ?? ""}`,
    );
  }
  const paused = manifest.acquisition.accounts.filter(
    (account) => account.state === AccountState.Paused,
  );
  if (paused.length > 0) {
    yield* Console.log(
      `${paused.length} account(s) paused; re-run acquire to retry or abandon-account to give up`,
    );
  }
  yield* Console.log(`checkpoint: ${paths.checkpoint}`);
});

const printReport = Effect.fn("pilot.printReport")(function* (
  report: PilotReport,
): Effect.fn.Return<void> {
  const counts = report.normalization;
  if (counts !== null) {
    yield* Console.log(
      `normalization: ${counts.accepted.total} accepted (${counts.accepted.timeline} timeline, ${counts.accepted.embedded} embedded), ${counts.rejected.total} rejected, ${counts.duplicates} duplicates, ${counts.skippedOutsideWindow} outside window, ${counts.authors} authors`,
    );
    const rejections = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite)),
    )(counts.rejected.byReason).pipe(Effect.orDie);
    yield* Console.log(`rejections by reason: ${rejections}`);
    yield* Console.log(
      `coverage floor ${report.coverage.floor}: ${report.coverage.accountsReached}/${report.coverage.accountsTotal} account(s)`,
    );
    if (report.authorShare.topHandle !== null) {
      yield* Console.log(
        `top author share: @${report.authorShare.topHandle} ${(100 * (report.authorShare.topShare ?? 0)).toFixed(1)}%`,
      );
    }
  }
  const requests = report.acquisition.requests;
  yield* Console.log(
    `requests: ${requests.total} (${requests.retries} retries), latency mean ${fmt(requests.latencyMs.mean)} ms p95 ${fmt(requests.latencyMs.p95)} ms, rows/page mean ${fmt(requests.rowsPerPage.mean)}`,
  );
  yield* Console.log(`thresholds: ${report.thresholds.passed ? "passed" : "NOT passed"}`);
  for (const check of report.thresholds.checks) {
    const mark = check.passed === null ? "-" : check.passed ? "ok" : "FAIL";
    yield* Console.log(
      `  [${mark.padEnd(4)}] ${check.name}: ${check.value === null ? "n/a" : String(check.value)} (bound ${check.bound})`,
    );
  }
});

function fmt(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value * 10) / 10);
}

const requireRunId = Effect.fn("pilot.requireRunId")(function* (
  flags: Flags,
): Effect.fn.Return<string, PilotCliError> {
  const runId = flags.positional[0];
  if (runId === undefined) return yield* usageFail("A run id is required.");
  return runId;
});

const integerOptionEffect = Effect.fn("pilot.integerOption")(function* (
  flags: Flags,
  name: string,
  fallback: number,
): Effect.fn.Return<number, PilotCliError> {
  const value = flags.options.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return yield* usageFail(`--${name} must be a non-negative integer.`);
  }
  return parsed;
});

const parseFlagsEffect = Effect.fn("pilot.parseFlags")(function* (
  args: string[],
): Effect.fn.Return<Flags, PilotCliError> {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) options.set(key as string, inline);
      else {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) {
          return yield* usageFail(`Missing value for --${key}.`);
        }
        options.set(key as string, next);
        index += 1;
      }
    } else positional.push(arg);
  }
  return { positional, options };
});

function usageFail(message: string): PilotCliError {
  return new PilotCliError({ message: `${message}\n${USAGE}`, exitCode: 2 });
}

function cliFail(message: string): PilotCliError {
  return new PilotCliError({ message, exitCode: 1 });
}

function tryPromise<A>(promise: Promise<A>): Effect.Effect<A, Error> {
  // oxlint-disable-next-line effecttsgo/global-error-in-effect-catch -- CliError includes Error by design; this helper bridges promise-land rejections into that channel.
  return Effect.tryPromise({
    try: () => promise,
    // oxlint-disable-next-line effecttsgo/global-error-in-effect-failure -- intentional passthrough: preserves typed errors (FsError, etc.), wraps only truly-unknown throws.
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

CollectorRuntime.runPromise(main()).catch((error: unknown) => {
  if (error instanceof PilotCliError) {
    Effect.runSync(Console.error(error.message));
    process.exitCode = error.exitCode;
    return;
  }
  if (
    error instanceof PilotConfigError ||
    (error instanceof Error && "_tag" in error && (error as { _tag: string })._tag === "FsError")
  ) {
    Effect.runSync(Console.error(error instanceof Error ? error.message : error));
    process.exitCode = 1;
    return;
  }
  Effect.runSync(Console.error(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});

import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { CollectorLive } from "../contracts/liveLayers.ts";
import { posixPath } from "../contracts/posixPath.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FxTwitterLive } from "../acquisition/fxtwitter.ts";
import { runTimelineProbeEffect, type ProbeOptions, type ProbeReport } from "../probe/run.ts";

const DEFAULT_BASE_URL = "https://api.fxtwitter.com";
const ProbeFlag = {
  withoutReplies: "--without-replies",
  pages: "--pages",
  count: "--count",
  output: "--out",
  delay: "--delay-ms",
  timeout: "--timeout-ms",
  retries: "--retries",
  baseUrl: "--base-url",
} as const;

const main = Effect.fn("cli.probe")(function* (options: CliOptions) {
  const report = yield* runTimelineProbeEffect(options);
  yield* printSummary(report, options.outputDirectory);
});

interface CliOptions extends ProbeOptions {
  timeoutMs: number;
  retries: number;
}

function parseArguments(args: string[]): CliOptions {
  let position = 0;
  const handle = args[position++];
  if (handle === undefined || handle.startsWith("-")) usage("A profile handle is required.");

  const parsed: CliOptions = {
    handle: handle.replace(/^@/, ""),
    pages: 10,
    count: 100,
    withReplies: true,
    outputDirectory: posixPath.resolve(
      `data/collection-probes/${handle.replace(/^@/, "").toLowerCase()}`,
    ),
    delayMs: 250,
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: 15_000,
    retries: 3,
  };

  while (position < args.length) {
    const flag = args[position++];
    if (flag === ProbeFlag.withoutReplies) {
      parsed.withReplies = false;
      continue;
    }
    const value = args[position++];
    if (value === undefined) usage(`Missing value for ${flag ?? "option"}.`);

    switch (flag) {
      case ProbeFlag.pages:
        parsed.pages = integer(value, flag);
        break;
      case ProbeFlag.count:
        parsed.count = integer(value, flag);
        break;
      case ProbeFlag.output:
        parsed.outputDirectory = posixPath.resolve(value);
        break;
      case ProbeFlag.delay:
        parsed.delayMs = integer(value, flag);
        break;
      case ProbeFlag.timeout:
        parsed.timeoutMs = integer(value, flag);
        break;
      case ProbeFlag.retries:
        parsed.retries = integer(value, flag);
        break;
      case ProbeFlag.baseUrl:
        parsed.baseUrl = value;
        break;
      default:
        usage(`Unknown option: ${flag ?? ""}`);
    }
  }

  return parsed;
}

function integer(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) usage(`${flag} must be an integer.`);
  return parsed;
}

const printSummary = Effect.fn("cli.printSummary")(function* (
  report: ProbeReport,
  outputDirectory: string,
): Effect.fn.Return<void> {
  const oldest =
    report.oldestCreatedAt === null
      ? "n/a"
      : DateTime.make(report.oldestCreatedAt).pipe(Option.getOrThrow, DateTime.formatIso);
  const newest =
    report.newestCreatedAt === null
      ? "n/a"
      : DateTime.make(report.newestCreatedAt).pipe(Option.getOrThrow, DateTime.formatIso);
  const missing = Object.entries(report.missingRequiredFields);

  yield* Console.log(`FxTwitter timeline probe: @${report.handle}`);
  yield* Console.log(`pages: ${report.pagesCompleted}`);
  yield* Console.log(
    `results: ${report.totalResults} (${report.uniqueTweets} unique, ${report.duplicateTweets} duplicates)`,
  );
  yield* Console.log(`range: ${oldest} .. ${newest}`);
  yield* Console.log(`stop: ${report.stopReason}`);
  const missingFields =
    missing.length === 0
      ? "none"
      : yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite)),
        )(report.missingRequiredFields).pipe(Effect.orDie);
  yield* Console.log(`missing required fields: ${missingFields}`);
  yield* Console.log(`report: ${posixPath.resolve(outputDirectory, "report.json")}`);
});

function usage(message: string): never {
  Effect.runSync(Console.error(message));
  Effect.runSync(
    Console.error(
      "Usage: pnpm collect:probe <handle> [--pages 10] [--count 100] [--out directory] [--without-replies]",
    ),
  );
  process.exit(2);
}

const options = parseArguments(process.argv.slice(2));
// The CLI owns the client layer: one runtime per invocation, built from flags.
const runtime = ManagedRuntime.make(
  Layer.merge(
    FxTwitterLive({
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    }),
    CollectorLive,
  ),
);

runtime.runPromise(main(options)).catch((error: unknown) => {
  Effect.runSync(Console.error(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});

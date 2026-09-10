// Test-side file helpers backed by the collector's Effect runtime: fixtures go
// through the same FileSystem service the app uses instead of raw `node:fs`,
// so the test tree exercises one file API and no node built-ins leak in.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { CollectorRuntime } from "../../src/contracts/runtime.ts";

export { posixPath } from "../../src/contracts/posixPath.ts";

/** Read a file as UTF-8 text. */
export function readText(path: string): Promise<string> {
  return CollectorRuntime.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)),
  );
}

/** Create a fresh temporary directory (the caller records it for cleanup). */
export function makeTempDirectory(prefix = "xearch-test-"): Promise<string> {
  return CollectorRuntime.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectory({ prefix })),
  );
}

/** Recursively remove a path, ignoring a missing target. */
export function removeRecursively(path: string): Promise<void> {
  return CollectorRuntime.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(path, { recursive: true, force: true }),
    ),
  );
}

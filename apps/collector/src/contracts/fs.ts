import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class FsError extends Data.TaggedError("FsError")<{
  readonly message: string;
  readonly path: string;
  readonly operation: "read" | "write" | "stat" | "list" | "move" | "mkdir";
  readonly cause: unknown;
}> {}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function fsFail(
  path: string,
  operation: FsError["operation"],
  message: string,
  cause: unknown,
): FsError {
  return new FsError({ message, path, operation, cause });
}

export const writeTextAtomicEffect = Effect.fn("writeTextAtomicEffect")(function* (
  path: string,
  text: string,
): Effect.fn.Return<void, FsError> {
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.tmp`;
      await writeFile(temporaryPath, text, "utf8");
      await rename(temporaryPath, path);
    },
    catch: (cause) => fsFail(path, "write", `failed to write ${path}`, cause),
  });
});

export const writeJsonAtomicEffect = Effect.fn("writeJsonAtomicEffect")(function* (
  path: string,
  value: unknown,
): Effect.fn.Return<void, FsError> {
  return yield* writeTextAtomicEffect(path, `${JSON.stringify(value, null, 2)}\n`);
});

export const readTextEffect = Effect.fn("readTextEffect")(function* (
  path: string,
): Effect.fn.Return<string, FsError> {
  return yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => fsFail(path, "read", `failed to read ${path}`, cause),
  });
});

export const readJsonEffect = Effect.fn("readJsonEffect")(function* (
  path: string,
): Effect.fn.Return<unknown, FsError> {
  const text = yield* readTextEffect(path);
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => fsFail(path, "read", `failed to parse JSON at ${path}`, cause),
  });
});

export const readJsonIfExistsEffect = Effect.fn("readJsonIfExistsEffect")(function* (
  path: string,
): Effect.fn.Return<unknown | null, FsError> {
  return yield* Effect.catch(readJsonEffect(path), (error) => {
    if (isNodeError(error.cause) && error.cause.code === "ENOENT") {
      return Effect.succeed(null);
    }
    return error;
  });
});

export const fileExistsEffect = Effect.fn("fileExistsEffect")(function* (
  path: string,
): Effect.fn.Return<boolean, FsError> {
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        await stat(path);
        return true;
      } catch (cause) {
        if (isNodeError(cause) && cause.code === "ENOENT") return false;
        throw cause;
      }
    },
    catch: (cause) => fsFail(path, "stat", `failed to stat ${path}`, cause),
  });
});

export const sha256FileEffect = Effect.fn("sha256FileEffect")(function* (
  path: string,
): Effect.fn.Return<{ bytes: number; sha256: string }, FsError> {
  return yield* Effect.tryPromise({
    try: async () => {
      const buffer = await readFile(path);
      return {
        bytes: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    },
    catch: (cause) => fsFail(path, "read", `failed to hash ${path}`, cause),
  });
});

export const listFilesEffect = Effect.fn("listFilesEffect")(function* (
  root: string,
): Effect.fn.Return<string[], FsError> {
  return yield* Effect.tryPromise({
    try: async () => {
      const out: string[] = [];
      async function walk(directory: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(directory, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) out.push(relative(root, full).split("\\").join("/"));
        }
      }
      await walk(root);
      return out.sort();
    },
    catch: (cause) => fsFail(root, "list", `failed to list ${root}`, cause),
  });
});

export const moveDirectoryEffect = Effect.fn("moveDirectoryEffect")(function* (
  from: string,
  to: string,
): Effect.fn.Return<void, FsError> {
  const exists = yield* fileExistsEffect(to);
  if (exists) {
    return yield* fsFail(to, "move", `destination already exists: ${to}`, null);
  }
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
    },
    catch: (cause) => fsFail(to, "move", `failed to move ${from} to ${to}`, cause),
  });
});

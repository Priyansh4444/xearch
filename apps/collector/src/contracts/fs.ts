import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { posixPath } from "./posixPath.ts";

export class FsError extends Data.TaggedError("FsError")<{
  readonly message: string;
  readonly path: string;
  readonly operation: "read" | "write" | "stat" | "list" | "move" | "mkdir";
  readonly cause: unknown;
}> {}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof PlatformError.PlatformError &&
    error.reason instanceof PlatformError.SystemError &&
    error.reason._tag === "NotFound"
  );
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
): Effect.fn.Return<void, FsError, FileSystem.FileSystem> {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(posixPath.dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    yield* fs.writeFileString(temporaryPath, text);
    yield* fs.rename(temporaryPath, path);
  }).pipe(Effect.mapError((cause) => fsFail(path, "write", `failed to write ${path}`, cause)));
});

export const writeJsonAtomicEffect = Effect.fn("writeJsonAtomicEffect")(function* (
  path: string,
  value: unknown,
): Effect.fn.Return<void, FsError, FileSystem.FileSystem> {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
    value,
  ).pipe(Effect.orDie);
  return yield* writeTextAtomicEffect(path, `${body}\n`);
});

export const readTextEffect = Effect.fn("readTextEffect")(function* (
  path: string,
): Effect.fn.Return<string, FsError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((cause) => fsFail(path, "read", `failed to read ${path}`, cause)));
});

export const readJsonEffect = Effect.fn("readJsonEffect")(function* (
  path: string,
): Effect.fn.Return<unknown, FsError, FileSystem.FileSystem> {
  const text = yield* readTextEffect(path);
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError((cause) => fsFail(path, "read", `failed to parse JSON at ${path}`, cause)),
  );
});

export const readJsonIfExistsEffect = Effect.fn("readJsonIfExistsEffect")(function* (
  path: string,
): Effect.fn.Return<unknown, FsError, FileSystem.FileSystem> {
  return yield* Effect.catch(readJsonEffect(path), (error) => {
    if (isNotFound(error.cause)) {
      return Effect.succeed(null);
    }
    return error;
  });
});

export const fileExistsEffect = Effect.fn("fileExistsEffect")(function* (
  path: string,
): Effect.fn.Return<boolean, FsError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .exists(path)
    .pipe(Effect.mapError((cause) => fsFail(path, "stat", `failed to stat ${path}`, cause)));
});

export const sha256FileEffect = Effect.fn("sha256FileEffect")(function* (
  path: string,
): Effect.fn.Return<
  { bytes: number; sha256: string },
  FsError,
  FileSystem.FileSystem | Crypto.Crypto
> {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const bytes = yield* fs.readFile(path);
    const digest = yield* crypto.digest("SHA-256", bytes);
    return {
      bytes: bytes.byteLength,
      sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  }).pipe(Effect.mapError((cause) => fsFail(path, "read", `failed to hash ${path}`, cause)));
});

export const listFilesEffect = Effect.fn("listFilesEffect")(function* (
  root: string,
): Effect.fn.Return<string[], FsError, FileSystem.FileSystem> {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out: string[] = [];
    const walk = (directory: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(directory);
        for (const entry of entries) {
          const full = posixPath.join(directory, entry);
          const info = yield* fs.stat(full);
          if (info.type === "Directory") yield* walk(full);
          else if (info.type === "File")
            out.push(posixPath.relative(root, full).split("\\").join("/"));
        }
      });
    yield* walk(root);
    return out.sort();
  }).pipe(Effect.mapError((cause) => fsFail(root, "list", `failed to list ${root}`, cause)));
});

export const moveDirectoryEffect = Effect.fn("moveDirectoryEffect")(function* (
  from: string,
  to: string,
): Effect.fn.Return<void, FsError, FileSystem.FileSystem> {
  const exists = yield* fileExistsEffect(to);
  if (exists) {
    return yield* fsFail(to, "move", `destination already exists: ${to}`, null);
  }
  yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(posixPath.dirname(to), { recursive: true });
    yield* fs.rename(from, to);
  }).pipe(Effect.mapError((cause) => fsFail(to, "move", `failed to move ${from} to ${to}`, cause)));
});

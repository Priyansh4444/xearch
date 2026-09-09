// Local `it.effect` until `@effect/vitest` supports vitest 5 (its rc track
// caps vitest at <5.0.0 while this repo runs vitest 5). Same ergonomics:
// bodies run with a fresh TestClock-backed context, so time-based tests elapse
// virtual time via `TestClock.adjust` instead of sleeping for real. When the
// package catches up, this file becomes a re-export.
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { it } from "vitest";

export function itEffect<A, E>(
  name: string,
  body: Effect.Effect<A, E, never>,
  timeout?: number,
): void {
  it(name, () => Effect.runPromise(Effect.provide(body, TestClock.layer())), timeout);
}

// Effect-aware test runner for the collector suite, until `@effect/vitest`
// supports vitest 5 (its rc track caps vitest at <5.0.0 while this repo runs
// vitest 5). Call it as `it("name", () => runEffect(body))`: the callback stays
// a plain vitest test body, so the test lints (assertions present, no
// standalone expects, string titles) keep working, while the body runs with a
// fresh TestClock-backed context so time-based tests elapse virtual time via
// `TestClock.adjust` instead of sleeping for real. When the package catches up,
// this file becomes a re-export.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

/** Run an Effect test body with a fresh virtual clock (scoped: no stale state between tests). */
export function runEffect<A, E>(body: Effect.Effect<A, E, never>): Promise<A> {
  const withVirtualClock = Effect.gen(function* () {
    const clock = yield* TestClock.make();
    return yield* Effect.provideService(body, Clock.Clock, clock);
  });
  return Effect.runPromise(withVirtualClock.pipe(Effect.scoped));
}

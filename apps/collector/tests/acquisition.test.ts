import { createServer } from "node:http";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  FxTwitter,
  FxTwitterTest,
  makeFxTwitterClient,
  type TimelineRequest,
} from "../src/acquisition/fxtwitter.ts";
import { itEffect } from "./effect.ts";

const request: TimelineRequest = {
  handle: "NASA", count: 20, cursor: null, withReplies: false,
};
const page = () => Response.json({ code: 200, results: [], cursor: { top: null, bottom: null } });

describe("Effect acquisition", () => {
  itEffect(
    "honors Retry-After and resets attempts when reusing an Effect",
    Effect.gen(function* () {
      let calls = 0;
      const delays: number[] = [];
      const client = makeFxTwitterClient({
        retries: 1,
        fetchImpl: async () => ++calls % 2 === 1
          ? new Response("limited", { status: 429, headers: { "retry-after": "2" } })
          : page(),
        sleep: async (ms) => { delays.push(ms); },
      });
      const program = client.fetchTimelinePageEffect(request);
      expect((yield* program).attempts).toBe(2);
      expect((yield* program).attempts).toBe(2);
      expect(delays).toEqual([2000, 2000]);
    }),
  );

  it.each([400, 401, 403])("does not retry permanent HTTP %i failures", async (status) => {
    let calls = 0;
    const client = makeFxTwitterClient({
      fetchImpl: async () => { calls += 1; return new Response("denied", { status }); },
    });
    await expect(client.fetchTimelinePage(request)).rejects.toMatchObject({
      _tag: "FxTwitterError", kind: "http", status, responseBody: "denied",
    });
    expect(calls).toBe(1);
  });

  itEffect(
    "exhausts transport retries with a typed error",
    Effect.gen(function* () {
      let calls = 0;
      const delays: number[] = [];
      const client = makeFxTwitterClient({
        retries: 2, retryBaseDelayMs: 10,
        fetchImpl: async () => { calls += 1; throw new Error("connection closed"); },
        sleep: async (ms) => { delays.push(ms); },
      });
      const exit = yield* Effect.exit(client.fetchTimelinePageEffect(request));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) ? failure.value : null).toMatchObject({
          _tag: "FxTwitterError", kind: "transport", status: null,
        });
      }
      expect(calls).toBe(3);
      expect(delays).toEqual([10, 20]);
    }),
  );

  it("does not retry malformed JSON or envelopes", async () => {
    for (const body of ["not json", '{"code":"200","results":[],"cursor":{}}']) {
      let calls = 0;
      const client = makeFxTwitterClient({
        fetchImpl: async () => { calls += 1; return new Response(body); },
      });
      await expect(client.fetchTimelinePage(request)).rejects.toMatchObject({ kind: "decode" });
      expect(calls).toBe(1);
    }
  });

  itEffect(
    "backs off on the Effect clock without waiting for real",
    Effect.gen(function* () {
      let calls = 0;
      const program = Effect.gen(function* () {
        const client = yield* FxTwitter;
        return yield* Effect.exit(client.fetchTimelinePageEffect(request));
      }).pipe(
        Effect.provide(FxTwitterTest(
          async () => { calls += 1; throw new Error("connection closed"); },
          { retries: 2, retryBaseDelayMs: 5000 },
        )),
      );
      const fiber = yield* Effect.forkChild(program);
      // Virtual 15s elapses both backoffs (5s + 10s) instantly.
      yield* TestClock.adjust("15 seconds");
      const exit = yield* Fiber.join(fiber);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) ? failure.value : null).toMatchObject({
          _tag: "FxTwitterError", kind: "transport",
        });
      }
      expect(calls).toBe(3);
    }),
  );

  it("cancels an in-flight request without retrying it", async () => {
    const controller = new AbortController();
    let calls = 0;
    let aborted = false;
    const client = makeFxTwitterClient({
      fetchImpl: async (_url, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
          queueMicrotask(() => controller.abort());
        });
      },
    });
    // Plain `it`: runtime-level interruption comes from `runPromiseExit`'s
    // signal option, which has no in-Effect equivalent — nothing for itEffect
    // or TestClock to contribute here.
    const exit = await Effect.runPromiseExit(client.fetchTimelinePageEffect(request), {
      signal: controller.signal,
    });
    expect(exit._tag).toBe("Failure");
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it("preserves profile-not-found and empty-timeline outcomes", async () => {
    const client = makeFxTwitterClient({
      fetchImpl: async (url) => String(url).includes("/statuses")
        ? new Response(null, { status: 204 })
        : new Response("missing", { status: 404 }),
    });
    expect((await client.fetchProfile("missing")).profile).toBeNull();
    expect((await client.fetchTimelinePage(request)).page).toBeNull();
  });

  it("retries through a real HTTP connection", async () => {
    let calls = 0;
    const server = createServer((_req, response) => {
      calls += 1;
      response.writeHead(calls === 1 ? 503 : 200, { "content-type": "application/json" });
      response.end(calls === 1 ? "unavailable" : JSON.stringify({
        code: 200, results: [], cursor: { top: null, bottom: null },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP address");
      const client = makeFxTwitterClient({
        baseUrl: `http://127.0.0.1:${address.port}`, retryBaseDelayMs: 0, retries: 1,
      });
      expect((await client.fetchTimelinePage(request)).attempts).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

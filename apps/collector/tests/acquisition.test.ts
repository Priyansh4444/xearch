import { createServer } from "node:http";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  FxTwitter,
  makeFxTwitterClient,
  type TimelineRequest,
} from "../src/acquisition/fxtwitter.ts";
import { runEffect } from "./effect.ts";

const request: TimelineRequest = {
  handle: "NASA",
  count: 20,
  cursor: null,
  withReplies: false,
};
const page = () => Response.json({ code: 200, results: [], cursor: { top: null, bottom: null } });

describe("Effect acquisition", () => {
  it("honors Retry-After and resets attempts when reusing an Effect", () =>
    runEffect(
      Effect.gen(function* () {
        let calls = 0;
        const delays: number[] = [];
        const client = makeFxTwitterClient({
          retries: 1,
          fetchImpl: () =>
            Promise.resolve(
              ++calls % 2 === 1
                ? new Response("limited", { status: 429, headers: { "retry-after": "2" } })
                : page(),
            ),
          sleep: (ms) => {
            delays.push(ms);
          },
        });
        const program = client.fetchTimelinePageEffect(request);
        expect((yield* program).attempts).toBe(2);
        expect((yield* program).attempts).toBe(2);
        expect(delays).toEqual([2000, 2000]);
      }),
    ));

  it.each([400, 401, 402, 403, 404, 422])(
    "does not retry permanent HTTP %i failures",
    async (status) => {
      let calls = 0;
      const client = makeFxTwitterClient({
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response("denied", { status }));
        },
      });
      await expect(client.fetchTimelinePage(request)).rejects.toMatchObject({
        _tag: "FxTwitterError",
        kind: "http",
        status,
        responseBody: "denied",
      });
      expect(calls).toBe(1);
    },
  );

  it.each([429, 500, 502, 503, 504])("retries transient HTTP %i then succeeds", async (status) => {
    let calls = 0;
    const client = makeFxTwitterClient({
      retries: 1,
      retryBaseDelayMs: 0,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? new Response("busy", { status }) : page());
      },
      sleep: () => undefined,
    });
    expect((await client.fetchTimelinePage(request)).attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it.each([
    { name: "seconds", headers: { "retry-after": "2" }, expected: 2000 },
    { name: "missing falls back to exponential", headers: {}, expected: 500 },
    {
      name: "garbage falls back to exponential",
      headers: { "retry-after": "not-a-date" },
      expected: 500,
    },
    { name: "zero means retry now", headers: { "retry-after": "0" }, expected: 0 },
  ])("retry-after variant $name delays $expected ms", async ({ headers, expected }) => {
    let calls = 0;
    const delays: number[] = [];
    const client = makeFxTwitterClient({
      retries: 1,
      retryBaseDelayMs: 500,
      fetchImpl: () =>
        Promise.resolve(
          ++calls % 2 === 1 ? new Response("limited", { status: 429, headers }) : page(),
        ),
      sleep: (ms) => {
        delays.push(ms);
      },
    });
    expect((await client.fetchTimelinePage(request)).attempts).toBe(2);
    expect(delays).toEqual([expected]);
  });

  it.each(["retry-after", "Retry-After", "RETRY-AFTER"])(
    "header name case %j is honored (HTTP semantics)",
    async (name) => {
      let calls = 0;
      const delays: number[] = [];
      const client = makeFxTwitterClient({
        retries: 1,
        retryBaseDelayMs: 500,
        fetchImpl: () =>
          Promise.resolve(
            ++calls % 2 === 1
              ? new Response("limited", { status: 429, headers: { [name]: "2" } })
              : page(),
          ),
        sleep: (ms) => {
          delays.push(ms);
        },
      });
      expect((await client.fetchTimelinePage(request)).attempts).toBe(2);
      expect(delays).toEqual([2000]);
    },
  );

  it("exhausts transport retries with a typed error", () =>
    runEffect(
      Effect.gen(function* () {
        let calls = 0;
        const delays: number[] = [];
        const client = makeFxTwitterClient({
          retries: 2,
          retryBaseDelayMs: 10,
          fetchImpl: () => {
            calls += 1;
            return Promise.reject(new Error("connection closed"));
          },
          sleep: (ms) => {
            delays.push(ms);
          },
        });
        const exit = yield* Effect.exit(client.fetchTimelinePageEffect(request));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) ? failure.value : null).toMatchObject({
            _tag: "FxTwitterError",
            kind: "transport",
            status: null,
          });
        }
        expect(calls).toBe(3);
        expect(delays).toEqual([10, 20]);
      }),
    ));

  it.each([
    "not json",
    '{"code":"200","results":[],"cursor":{}}',
    '{"code":200}',
    '{"code":200,"results":{}}',
    "",
    "null",
    "[1,2,3]",
  ])("does not retry malformed envelope %j", async (body) => {
    let calls = 0;
    const client = makeFxTwitterClient({
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response(body));
      },
    });
    await expect(client.fetchTimelinePage(request)).rejects.toMatchObject({ kind: "decode" });
    expect(calls).toBe(1);
  });

  it("backs off on the Effect clock without waiting for real", () =>
    runEffect(
      Effect.gen(function* () {
        let calls = 0;
        const program = Effect.gen(function* () {
          const client = yield* FxTwitter;
          return yield* Effect.exit(client.fetchTimelinePageEffect(request));
        }).pipe(
          Effect.provideService(
            FxTwitter,
            makeFxTwitterClient({
              fetchImpl: () => {
                calls += 1;
                throw new Error("connection closed");
              },
              retries: 2,
              retryBaseDelayMs: 5000,
            }),
          ),
        );
        const fiber = yield* Effect.forkChild(program);
        // Virtual 15s elapses both backoffs (5s + 10s) instantly.
        yield* TestClock.adjust("15 seconds");
        const exit = yield* Fiber.join(fiber);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) ? failure.value : null).toMatchObject({
            _tag: "FxTwitterError",
            kind: "transport",
          });
        }
        expect(calls).toBe(3);
      }),
    ));

  it("cancels an in-flight request without retrying it", async () => {
    const controller = new AbortController();
    let calls = 0;
    let aborted = false;
    const client = makeFxTwitterClient({
      fetchImpl: (_url, init) => {
        calls += 1;
        return Effect.runPromise(
          Effect.callback<Response>((resume) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                resume(Effect.die(new Error("aborted")));
              },
              { once: true },
            );
            queueMicrotask(() => controller.abort());
          }),
        );
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

  it.each([
    { handle: "NASA", count: 20, cursor: null as string | null, withReplies: false },
    { handle: "NASA", count: 20, cursor: null as string | null, withReplies: true },
    { handle: "NASA", count: 100, cursor: "abc123", withReplies: true },
    { handle: "with space", count: 20, cursor: null as string | null, withReplies: false },
    { handle: "id:11348282", count: 20, cursor: "cursor==", withReplies: false },
  ])("timelineUrl encodes %j", (req) => {
    const client = makeFxTwitterClient();
    const url = new URL(client.timelineUrl(req));
    expect(url.searchParams.get("count")).toBe(String(req.count));
    expect(url.searchParams.get("cursor")).toBe(req.cursor);
    expect(url.searchParams.get("with_replies")).toBe(req.withReplies ? "true" : null);
    expect(url.pathname).toContain(encodeURIComponent(req.handle));
  });

  it("preserves profile-not-found and empty-timeline outcomes", async () => {
    const client = makeFxTwitterClient({
      fetchImpl: (input) =>
        Promise.resolve(
          (typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes("/statuses")
            ? new Response(null, { status: 204 })
            : new Response("missing", { status: 404 }),
        ),
    });
    expect((await client.fetchProfile("missing")).profile).toBeNull();
    expect((await client.fetchTimelinePage(request)).page).toBeNull();
  });

  it("retries through a real HTTP connection", async () => {
    let calls = 0;
    const server = createServer((_req, response) => {
      calls += 1;
      response.writeHead(calls === 1 ? 503 : 200, { "content-type": "application/json" });
      response.end(
        calls === 1
          ? "unavailable"
          : JSON.stringify({
              code: 200,
              results: [],
              cursor: { top: null, bottom: null },
            }),
      );
    });
    await Effect.runPromise(
      Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP address");
      const client = makeFxTwitterClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        retryBaseDelayMs: 0,
        retries: 1,
      });
      expect((await client.fetchTimelinePage(request)).attempts).toBe(2);
    } finally {
      server.closeAllConnections();
      await Effect.runPromise(
        Effect.callback<void>((resume) => {
          server.close((error) => {
            if (error !== undefined) resume(Effect.die(error));
            else resume(Effect.void);
          });
        }),
      );
    }
  });
});

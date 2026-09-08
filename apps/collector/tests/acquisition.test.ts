import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { FxTwitterClient, type TimelineRequest } from "../src/acquisition/fxtwitter.ts";

const request: TimelineRequest = {
  handle: "NASA", count: 20, cursor: null, withReplies: false,
};
const page = () => Response.json({ code: 200, results: [], cursor: { top: null, bottom: null } });

describe("Effect acquisition", () => {
  it("honors Retry-After and resets attempts when reusing an Effect", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new FxTwitterClient({
      retries: 1,
      fetchImpl: async () => ++calls % 2 === 1
        ? new Response("limited", { status: 429, headers: { "retry-after": "2" } })
        : page(),
      sleep: async (ms) => { delays.push(ms); },
    });
    const program = client.fetchTimelinePageEffect(request);
    expect((await Effect.runPromise(program)).attempts).toBe(2);
    expect((await Effect.runPromise(program)).attempts).toBe(2);
    expect(delays).toEqual([2000, 2000]);
  });

  it.each([400, 401, 403])("does not retry permanent HTTP %i failures", async (status) => {
    let calls = 0;
    const client = new FxTwitterClient({
      fetchImpl: async () => { calls += 1; return new Response("denied", { status }); },
    });
    await expect(client.fetchTimelinePage(request)).rejects.toMatchObject({
      _tag: "FxTwitterError", kind: "http", status, responseBody: "denied",
    });
    expect(calls).toBe(1);
  });

  it("exhausts transport retries with a typed error", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new FxTwitterClient({
      retries: 2, retryBaseDelayMs: 10,
      fetchImpl: async () => { calls += 1; throw new Error("connection closed"); },
      sleep: async (ms) => { delays.push(ms); },
    });
    await expect(client.fetchTimelinePage(request)).rejects.toMatchObject({
      _tag: "FxTwitterError", kind: "transport", status: null,
    });
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("does not retry malformed JSON or envelopes", async () => {
    for (const body of ["not json", '{"code":"200","results":[],"cursor":{}}']) {
      let calls = 0;
      const client = new FxTwitterClient({
        fetchImpl: async () => { calls += 1; return new Response(body); },
      });
      await expect(client.fetchTimelinePage(request)).rejects.toMatchObject({ kind: "decode" });
      expect(calls).toBe(1);
    }
  });

  it("cancels an in-flight request without retrying it", async () => {
    const controller = new AbortController();
    let calls = 0;
    let aborted = false;
    const client = new FxTwitterClient({
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
    const exit = await Effect.runPromiseExit(client.fetchTimelinePageEffect(request), {
      signal: controller.signal,
    });
    expect(exit._tag).toBe("Failure");
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it("preserves profile-not-found and empty-timeline outcomes", async () => {
    const client = new FxTwitterClient({
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
      const client = new FxTwitterClient({
        baseUrl: `http://127.0.0.1:${address.port}`, retryBaseDelayMs: 0, retries: 1,
      });
      expect((await client.fetchTimelinePage(request)).attempts).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

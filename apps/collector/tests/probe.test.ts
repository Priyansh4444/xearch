import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FxTwitterClient,
  type TimelineClient,
  type TimelineRequest,
} from "../src/acquisition/fxtwitter.ts";
import { runTimelineProbe } from "../src/probe/run.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("FxTwitter client", () => {
  it("retries transient responses and parses the documented timeline envelope", async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return new Response("upstream failed", { status: 500 });
      return Response.json({ code: 200, results: [], cursor: { top: null, bottom: null } });
    };
    const client = new FxTwitterClient({
      fetchImpl: fetchImpl as typeof fetch,
      retries: 1,
      retryBaseDelayMs: 0,
      sleep: async () => undefined,
    });

    const response = await client.fetchTimelinePage({
      handle: "NASA",
      count: 20,
      cursor: null,
      withReplies: true,
    });

    expect(calls).toBe(2);
    expect(response.attempts).toBe(2);
    expect(response.page?.results).toEqual([]);
  });
});

describe("timeline probe", () => {
  it("measures duplicates, field gaps, content kinds, and cursor progress", async () => {
    const outputDirectory = await temporaryDirectory();
    const pages = [
      timelineResponse(
        [status("1", 1_700_000_000), status("2", 1_699_000_000, { quote: true })],
        "next",
      ),
      timelineResponse(
        [
          status("2", 1_699_000_000, { quote: true }),
          status("3", 1_698_000_000, { reply: true, mediaType: "photo" }),
        ],
        null,
      ),
    ];
    const requests: TimelineRequest[] = [];
    const client: TimelineClient = {
      async fetchTimelinePage(request) {
        requests.push(request);
        const response = pages.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    };

    const report = await runTimelineProbe(client, {
      handle: "NASA",
      pages: 10,
      count: 100,
      withReplies: true,
      outputDirectory,
      delayMs: 0,
      baseUrl: "https://api.fxtwitter.com",
    });

    expect(requests.map((request) => request.cursor)).toEqual([null, "next"]);
    expect(report.pagesCompleted).toBe(2);
    expect(report.totalResults).toBe(4);
    expect(report.uniqueTweets).toBe(3);
    expect(report.duplicateTweets).toBe(1);
    expect(report.stopReason).toBe("no-next-cursor");
    expect(report.missingRequiredFields).toEqual({});
    expect(report.pages[1]?.kinds).toMatchObject({ replies: 1, images: 1 });
    expect(JSON.parse(await readFile(join(outputDirectory, "raw/000001.json"), "utf8"))).toHaveProperty(
      "results",
    );
  });

  it("resumes from the checkpoint cursor without repeating the first page", async () => {
    const outputDirectory = await temporaryDirectory();
    const firstClient = fixedClient([
      timelineResponse([status("1", 1_700_000_000)], "next"),
    ]);
    const options = {
      handle: "NASA",
      pages: 1,
      count: 100,
      withReplies: true,
      outputDirectory,
      delayMs: 0,
      baseUrl: "https://api.fxtwitter.com",
    };

    const firstReport = await runTimelineProbe(firstClient.client, options);
    expect(firstReport.stopReason).toBe("page-limit");

    const secondClient = fixedClient([
      timelineResponse([status("2", 1_699_000_000)], null),
    ]);
    const resumedReport = await runTimelineProbe(secondClient.client, options);

    expect(secondClient.requests).toHaveLength(1);
    expect(secondClient.requests[0]?.cursor).toBe("next");
    expect(resumedReport.uniqueTweets).toBe(2);
    expect(resumedReport.stopReason).toBe("no-next-cursor");
  });
});

function fixedClient(responses: ReturnType<typeof timelineResponse>[]): {
  client: TimelineClient;
  requests: TimelineRequest[];
} {
  const requests: TimelineRequest[] = [];
  return {
    requests,
    client: {
      async fetchTimelinePage(request) {
        requests.push(request);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    },
  };
}

function timelineResponse(results: unknown[], bottom: string | null) {
  const raw = { code: 200, results, cursor: { top: null, bottom } };
  return {
    httpStatus: 200,
    latencyMs: 25,
    attempts: 1,
    receivedAt: 1_700_000_000_000,
    raw,
    page: raw,
  };
}

function status(
  id: string,
  createdTimestamp: number,
  options: {
    quote?: boolean;
    reply?: boolean;
    mediaType?: "photo" | "video" | "gif";
  } = {},
): Record<string, unknown> {
  return {
    type: "status",
    id,
    text: `post ${id}`,
    created_timestamp: createdTimestamp,
    likes: 1,
    reposts: 2,
    quotes: 3,
    replies: 4,
    quote: options.quote ? { type: "status", id: "quoted" } : null,
    replying_to: options.reply ? { status: "parent" } : null,
    reposted_by: null,
    media: {
      all: options.mediaType
        ? [{ type: options.mediaType, url: "https://example.com/media" }]
        : [],
    },
    author: {
      id: "author-1",
      screen_name: "nasa",
      name: "NASA",
      followers: 10,
      following: 2,
      joined: "2007-12-19T20:20:32Z",
      verification: { verified: true },
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xearch-probe-"));
  temporaryDirectories.push(directory);
  return directory;
}

import { makeTempDirectory, posixPath, readText, removeRecursively } from "./support/fs.ts";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  FxTwitterError,
  FxTwitterErrorKind,
  type FxTwitterJson,
  type PilotClient,
  type TimelineRequest,
  type TimelineResponse,
} from "../src/acquisition/fxtwitter.ts";
import { runTimelineProbe } from "../src/probe/run.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeRecursively(directory)),
  );
});

describe("timeline probe", () => {
  it.each([true, false])(
    "measures duplicates, gaps, kinds, cursor progress (withReplies=%j)",
    async (withReplies) => {
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
      const client = timelineClientFromPromises((request) => {
        requests.push(request);
        const response = pages.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      });

      const report = await runTimelineProbe(client, {
        handle: "NASA",
        pages: 10,
        count: 100,
        withReplies,
        outputDirectory,
        delayMs: 0,
        baseUrl: "https://api.fxtwitter.com",
      });

      expect(requests.every((request) => request.withReplies === withReplies)).toBe(true);

      expect(requests.map((request) => request.cursor)).toEqual([null, "next"]);
      expect(report.pagesCompleted).toBe(2);
      expect(report.totalResults).toBe(4);
      expect(report.uniqueTweets).toBe(3);
      expect(report.duplicateTweets).toBe(1);
      expect(report.stopReason).toBe("no-next-cursor");
      expect(report.missingRequiredFields).toEqual({});
      expect(report.pages[1]?.kinds).toMatchObject({ replies: 1, images: 1 });
      expect(
        JSON.parse(await readText(posixPath.join(outputDirectory, "raw/000001.json"))),
      ).toHaveProperty("results");
    },
  );

  it("resumes from the checkpoint cursor without repeating the first page", async () => {
    const outputDirectory = await temporaryDirectory();
    const firstClient = fixedClient([timelineResponse([status("1", 1_700_000_000)], "next")]);
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

    const secondClient = fixedClient([timelineResponse([status("2", 1_699_000_000)], null)]);
    const resumedReport = await runTimelineProbe(secondClient.client, options);

    expect(secondClient.requests).toHaveLength(1);
    expect(secondClient.requests[0]?.cursor).toBe("next");
    expect(resumedReport.uniqueTweets).toBe(2);
    expect(resumedReport.stopReason).toBe("no-next-cursor");
  });
});

function fixedClient(responses: ReturnType<typeof timelineResponse>[]): {
  client: PilotClient;
  requests: TimelineRequest[];
} {
  const requests: TimelineRequest[] = [];
  return {
    requests,
    client: timelineClientFromPromises((request) => {
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    }),
  };
}

function timelineClientFromPromises(
  fetchTimelinePage: (request: TimelineRequest) => TimelineResponse | Promise<TimelineResponse>,
): PilotClient {
  const baseUrl = "https://api.fxtwitter.com";
  return {
    baseUrl,
    timelineUrl: (request) => {
      const url = new URL(`${baseUrl}/2/profile/${encodeURIComponent(request.handle)}/statuses`);
      url.searchParams.set("count", String(request.count));
      if (request.cursor !== null) url.searchParams.set("cursor", request.cursor);
      if (request.withReplies) url.searchParams.set("with_replies", "true");
      return url.toString();
    },
    fetchTimelinePage: (request) => Promise.resolve(fetchTimelinePage(request)),
    fetchTimelinePageEffect: (request) =>
      Effect.tryPromise({
        try: () => Promise.resolve(fetchTimelinePage(request)),
        catch: (cause) =>
          cause instanceof FxTwitterError
            ? cause
            : new FxTwitterError({
                message: cause instanceof Error ? cause.message : String(cause),
                status: null,
                responseBody: null,
                kind: FxTwitterErrorKind.Transport,
                retryDelay: 0,
              }),
      }),
    // Probe never resolves profiles; loud stubs keep the fake honest.
    profileUrl: (handle) => `${baseUrl}/2/profile/${encodeURIComponent(handle)}`,
    fetchProfile: () => {
      throw new Error("profile lookup not used by probe tests");
    },
    fetchProfileEffect: () => Effect.die(new Error("profile lookup not used by probe tests")),
  };
}

function timelineResponse(results: FxTwitterJson[], bottom: string | null) {
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
): FxTwitterJson {
  return {
    type: "status",
    id,
    text: `post ${id}`,
    created_timestamp: createdTimestamp,
    likes: 1,
    reposts: 2,
    quotes: 3,
    replies: 4,
    quote: options.quote === true ? { type: "status", id: "quoted" } : null,
    replying_to: options.reply === true ? { status: "parent" } : null,
    reposted_by: null,
    media: {
      all:
        options.mediaType !== undefined
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
  const directory = await makeTempDirectory("xearch-probe-");
  temporaryDirectories.push(directory);
  return directory;
}

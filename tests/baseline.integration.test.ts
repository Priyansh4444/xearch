import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { BASELINE_CANDIDATE_CAP } from "../convex/search";

const modules = import.meta.glob("../convex/**/*.*s");

function tweet(
  tweetId: string,
  text: string,
  overrides: Partial<Omit<Doc<"tweets">, "_id" | "_creationTime">> = {},
) {
  return {
    tweetId,
    authorId: "a",
    authorHandle: "alice",
    text,
    createdAt: Date.UTC(2026, 0, 2),
    metricsAt: Date.UTC(2026, 0, 3),
    likeCount: 10,
    retweetCount: 0,
    replyCount: 0,
    quoteCount: 0,
    mediaType: "none",
    mediaUrls: [],
    hasLink: false,
    tokenCount: 5,
    staticScore: 1,
    propagatedBoost: 0,
    lang: "en",
    ...overrides,
  } satisfies Omit<Doc<"tweets">, "_id" | "_creationTime">;
}

async function seed(rows: ReturnType<typeof tweet>[]) {
  const tc = convexTest(schema, modules);
  await tc.run(async (ctx) => {
    await ctx.db.insert("authors", {
      authorId: "a",
      handle: "alice",
      displayName: "Alice",
      nameTokens: ["alice"],
      followerCount: 10,
      followingCount: 1,
      verified: false,
      authority: 1,
      isStub: false,
    });
    for (const row of rows) await ctx.db.insert("tweets", row);
  });
  return tc;
}

describe("literal baseline search", () => {
  test("does not turn a malformed React compiler query into CP VMs results", async () => {
    const tc = await seed([
      tweet("cp", "New cp VMs are available for cloud compute"),
      tweet("react", "React compiler makes components faster"),
      tweet("both", "React cp VMs"),
    ]);
    expect(await tc.query(api.search.searchBaseline, { raw: "react cp,[o;er]" })).toEqual([]);
    expect(
      (await tc.query(api.search.searchBaseline, { raw: "react compiler" })).map((t) => t.tweetId),
    ).toEqual(["react"]);
  });

  test("requires every meaningful token and never performs implicit author linking", async () => {
    const tc = await seed([
      tweet("partial", "react native"),
      tweet("match", "The React compiler from Alice"),
      tweet("prefix", "react compilers"),
    ]);
    expect(
      (await tc.query(api.search.searchBaseline, { raw: "the react compiler alice" })).map(
        (t) => t.tweetId,
      ),
    ).toEqual(["match"]);
  });

  test("searches an all-stopword query through the built-in index", async () => {
    const tc = await seed([
      tweet("stopword", "and so is the compiler"),
      tweet("partial", "and so the compiler"),
      tweet("none", "react compiler"),
    ]);
    // The posting index has no entries for stopwords. The literal lane retrieves
    // their tokens from the built-in full-text index and still checks every one.
    expect(
      (await tc.query(api.search.searchBaseline, { raw: "and so is" })).map((t) => t.tweetId),
    ).toEqual(["stopword"]);
    expect(
      (await tc.query(api.search.searchBaseline, { raw: '"and so is"' })).map((t) => t.tweetId),
    ).toEqual(["stopword"]);
    expect(await tc.query(api.search.searchBaseline, { raw: "and yet" })).toEqual([]);
  });

  test("Top orders the verified page with the shared deterministic ranker", async () => {
    const tc = await seed([
      tweet("quiet", "waterfall thread", { likeCount: 1 }),
      tweet("viral", "waterfall debug", { likeCount: 5000, retweetCount: 40 }),
      tweet("mid", "waterfall trace", { likeCount: 50 }),
    ]);
    const rows = await tc.query(api.search.searchBaseline, { raw: "waterfall" });
    expect(rows.map((t) => t.tweetId)).toEqual(["viral", "mid", "quiet"]);
    const latest = await tc.query(api.search.searchBaseline, {
      raw: "waterfall",
      sort: "latest",
    });
    expect(latest).toHaveLength(3);
  });

  test("preserves explicit author, media, date, likes, language, phrase and exclusion", async () => {
    const good = tweet("good", "React compiler is ready", { mediaType: "image" });
    const tc = await seed([
      good,
      tweet("author", good.text, { mediaType: "image", authorId: "b" }),
      tweet("media", good.text),
      tweet("date", good.text, { mediaType: "image", createdAt: Date.UTC(2026, 0, 3) }),
      tweet("likes", good.text, { mediaType: "image", likeCount: 0 }),
      tweet("lang", good.text, { mediaType: "image", lang: "fr" }),
      tweet("phrase", "compiler for react", { mediaType: "image" }),
      tweet("exclude", "React compiler beta", { mediaType: "image" }),
    ]);
    for (const [filter, rejected] of [
      ["from:alice", "author"],
      ["has:image", "media"],
      ["since:2026-01-02 until:2026-01-03", "date"],
      ["min_likes:5", "likes"],
      ["lang:en", "lang"],
    ]) {
      const rows = await tc.query(api.search.searchBaseline, {
        raw: `${filter} "react compiler" -beta`,
      });
      const ids = rows.map((t) => t.tweetId);
      expect(ids).toContain("good");
      expect(ids).not.toContain(rejected);
      expect(ids).not.toContain("phrase");
      expect(ids).not.toContain("exclude");
      expect(rows.find((t) => t.tweetId === "good")?.author?.displayName).toBe("Alice");
    }
  });

  test("rejects unresolved operators and filter-only queries without broadening", async () => {
    const tc = await seed([tweet("react", "react")]);
    await expect(
      tc.query(api.search.searchBaseline, { raw: "from:missing react" }),
    ).rejects.toThrow("Unknown author");
    await expect(
      tc.query(api.search.searchBaseline, { raw: "since:2026-99-99 react" }),
    ).rejects.toThrow("invalid date");
    await expect(tc.query(api.search.searchBaseline, { raw: "has:image" })).rejects.toThrow(
      "Add a search word",
    );
    expect(await tc.query(api.search.searchBaseline, { raw: " " })).toEqual([]);
  });

  test("Latest sorts the bounded candidate window and explicit sort wins", async () => {
    const tc = await seed(
      Array.from({ length: 30 }, (_, i) => tweet(String(i), "react compiler", { createdAt: i })),
    );
    const top = await tc.query(api.search.searchBaseline, { raw: "react compiler" });
    const latest = await tc.query(api.search.searchBaseline, {
      raw: "react compiler",
      sort: "latest",
    });
    expect(top).toHaveLength(20);
    expect(latest.map((t) => t.createdAt)).toEqual(Array.from({ length: 20 }, (_, i) => 29 - i));
    expect(
      await tc.query(api.search.searchBaseline, { raw: "react compiler sort:top", sort: "latest" }),
    ).toEqual(top);
  });

  test("documents outside the bounded relevance window do not turn an empty result into proof", async () => {
    const rejected = Array.from({ length: BASELINE_CANDIDATE_CAP }, (_, i) =>
      tweet(`rejected-${i}`, "react compiler beta"),
    );
    const tc = await seed([...rejected, tweet("valid-later", "react compiler stable")]);
    const rows = await tc.query(api.search.searchBaseline, {
      raw: "react compiler -beta",
    });
    expect(rows).toEqual([]);
  });

  test("paginated baseline makes later candidates reachable without an unbounded read", async () => {
    const tc = await seed(
      Array.from({ length: 25 }, (_, i) => tweet(`page-${i}`, "react compiler")),
    );
    const first = await tc.query(api.search.searchBaselinePage, {
      raw: "react compiler",
      paginationOpts: { cursor: null, numItems: 1_000 },
    });
    expect(first.page).toHaveLength(20);
    expect(first.isDone).toBe(false);

    const second = await tc.query(api.search.searchBaselinePage, {
      raw: "react compiler",
      paginationOpts: { cursor: first.continueCursor, numItems: 1_000 },
    });
    expect(second.page).toHaveLength(5);
    expect(second.isDone).toBe(true);
    expect(new Set([...first.page, ...second.page].map((row) => row.tweetId)).size).toBe(25);
  });
});

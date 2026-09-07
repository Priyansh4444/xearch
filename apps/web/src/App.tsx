import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";

type SearchReturn = FunctionReturnType<typeof api.search.search>;
type BaselineResults = FunctionReturnType<typeof api.search.searchBaseline>;
type Result = BaselineResults[number] & {
  matchedVia?: SearchReturn["results"][number]["matchedVia"];
};
type Lane = "xearch" | "baseline";
type Sort = "top" | "latest";

interface Shown {
  results: Result[];
  ladder: SearchReturn["ladder"] | null;
  queryKey: string | null;
  /** Terms that actually gated/boosted retrieval — what highlighting should mark. */
  terms: string[];
}

/** Known-dense corpus topics — each returns real posts from the archived run. */
const DEMO_QUERIES = ["bun", "pricing", "rust", "react server components", "agents"];

const DEBOUNCE_MS = 250;

export function App() {
  const params = new URLSearchParams(window.location.search);
  const initial = params.get("q") ?? "";
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState(initial.trim());
  const [sort, setSort] = useState<Sort>(params.get("sort") === "latest" ? "latest" : "top");
  const [lane, setLane] = useState<Lane>(params.get("lane") === "baseline" ? "baseline" : "xearch");

  useEffect(() => {
    const handle = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [input]);

  // Keep the query shareable: /?q=...&sort=...&lane=... mirrors the controls.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query === "") url.searchParams.delete("q");
    else url.searchParams.set("q", query);
    if (sort === "top") url.searchParams.delete("sort");
    else url.searchParams.set("sort", sort);
    if (lane === "xearch") url.searchParams.delete("lane");
    else url.searchParams.set("lane", lane);
    window.history.replaceState(null, "", url);
  }, [query, sort, lane]);

  const full = useQuery(
    api.search.search,
    query === "" || lane !== "xearch" ? "skip" : { raw: query, sort },
  );
  const baseline = useQuery(
    api.search.searchBaseline,
    query === "" || lane !== "baseline" ? "skip" : { raw: query },
  );

  const current: Shown | undefined = useMemo(() => {
    if (lane === "baseline") {
      return baseline === undefined
        ? undefined
        : { results: baseline, ladder: null, queryKey: null, terms: query.split(/\s+/) };
    }
    if (full === undefined) return undefined;
    const q = full.appliedQuery;
    return {
      results: full.results,
      ladder: full.ladder,
      queryKey: full.queryKey,
      terms: [...q.must, ...q.should, ...q.phrases.flat(), ...q.exclude.map((t) => `-${t}`)],
    };
  }, [lane, full, baseline, query]);

  // Keep the previous list on screen while a new query loads (no layout flash).
  const lastShown = useRef<Shown | null>(null);
  if (current !== undefined && query !== "") lastShown.current = current;
  const shown = query === "" ? null : (current ?? lastShown.current ?? undefined);
  const searching = query !== "" && current === undefined;

  return (
    <div className="page">
      <header className="masthead">
        <h1 className="wordmark">xearch</h1>
        <p className="lane-note">literal lane: exact words, real posts</p>
      </header>

      <div className={searching ? "searchbox is-searching" : "searchbox"}>
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="search 164,959 posts"
          aria-label="Search posts"
          autoFocus
        />
        {/* Only while the input is ahead of the executed query — typing, not idle. */}
        {input.trim() !== query ? (
          <Typeahead input={input} onPick={(q) => { setInput(q); setQuery(q); }} />
        ) : null}
      </div>

      {query !== "" ? (
        <div className="controls">
          <div className="tabs" role="tablist" aria-label="Sort">
            {((["top", "latest"] as const)).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={sort === s}
                className={sort === s ? "tab active" : "tab"}
                onClick={() => setSort(s)}
                disabled={lane === "baseline"}
              >
                {s === "top" ? "Top" : "Latest"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="lane-toggle"
            onClick={() => setLane(lane === "xearch" ? "baseline" : "xearch")}
            title="A/B: xearch's own index vs Convex built-in full-text search"
          >
            lane: {lane}
          </button>
        </div>
      ) : null}

      {query === "" ? (
        <Intro onPick={(q) => { setInput(q); setQuery(q); }} />
      ) : shown === undefined || shown === null ? (
        <SkeletonList />
      ) : shown.results.length === 0 ? (
        <EmptyState query={query} onPick={(q) => { setInput(q); setQuery(q); }} />
      ) : (
        <main aria-busy={searching}>
          <p className="count-line">
            {shown.results.length === 20
              ? "top 20 posts"
              : `${shown.results.length} post${shown.results.length === 1 ? "" : "s"}`}
            {shown.ladder !== null && shown.ladder !== "L0"
              ? ` — exact matches were thin; widened to related posts (${shown.ladder})`
              : shown.results.length > 0 && shown.results.length < 20
                ? " — every match in the corpus"
                : ""}
          </p>
          <ol className="results">
            {shown.results.map((t) => (
              <li key={t._id}>
                <ResultRow tweet={t} terms={shown.terms} queryKey={shown.queryKey} />
              </li>
            ))}
          </ol>
        </main>
      )}

      <footer className="colophon">
        <p>corpus: 62 tech accounts, six months deep, archived 2026-09-03. served by Convex full-text search.</p>
      </footer>
    </div>
  );
}

function Intro({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="intro">
      <p>Type a query to search the indexed corpus. Every result is a real post; nothing is mocked. Try one:</p>
      <DemoChips onPick={onPick} />
    </div>
  );
}

function EmptyState({ query, onPick }: { query: string; onPick: (q: string) => void }) {
  return (
    <div className="empty-state">
      <p>
        No posts contain <span className="query-echo">{query}</span>. The corpus is 62 tech accounts — try words people
        actually posted:
      </p>
      <DemoChips onPick={onPick} />
    </div>
  );
}

function DemoChips({ onPick }: { onPick: (q: string) => void }) {
  return (
    <ul className="chips">
      {DEMO_QUERIES.map((q) => (
        <li key={q}>
          <button type="button" onClick={() => onPick(q)}>
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SkeletonList() {
  return (
    <div className="skeletons" aria-label="Loading results">
      {[0, 1, 2].map((i) => (
        <div className="skeleton" key={i}>
          <div className="skeleton-bar w40" />
          <div className="skeleton-bar" />
          <div className="skeleton-bar w80" />
        </div>
      ))}
    </div>
  );
}

function Typeahead({ input, onPick }: { input: string; onPick: (q: string) => void }) {
  const lastWord = input.split(/\s+/).at(-1) ?? "";
  const suggestions = useQuery(
    api.search.suggest,
    lastWord.length >= 2 ? { prefix: lastWord } : "skip",
  );
  if (
    lastWord.length < 2 ||
    suggestions === undefined ||
    suggestions.filter((s) => s.term !== lastWord).length === 0
  ) {
    return null;
  }
  const complete = (term: string) =>
    [...input.split(/\s+/).slice(0, -1), term].join(" ");
  return (
    <ul className="typeahead" role="listbox" aria-label="Suggestions">
      {suggestions
        .filter((s) => s.term !== lastWord)
        .slice(0, 5)
        .map((s) => (
          <li key={s.term}>
            <button type="button" onClick={() => onPick(complete(s.term))}>
              {complete(s.term)}
              <span className="df">{s.df}</span>
            </button>
          </li>
        ))}
    </ul>
  );
}

/** Stable anonymous session for feedback dedupe (one vote per session per pair). */
function sessionId(): string {
  let id = localStorage.getItem("xearch-session");
  if (id === null) {
    id = crypto.randomUUID();
    localStorage.setItem("xearch-session", id);
  }
  return id;
}

function ResultRow({
  tweet,
  terms,
  queryKey,
}: {
  tweet: Result;
  terms: string[];
  queryKey: string | null;
}) {
  const vote = useMutation(api.feedback.vote);
  const [voted, setVoted] = useState<1 | -1 | null>(null);
  const name = tweet.author?.displayName ?? `@${tweet.authorHandle}`;
  return (
    <article className="result">
      <div className="byline">
        <span className="name">
          {name}
          {tweet.author?.verified ? (
            <svg className="verified" viewBox="0 0 24 24" aria-label="verified" role="img">
              <path d="M12 2l2.4 2.4 3.4-.5 1 3.3 3 1.7-1.2 3.1 1.2 3.1-3 1.7-1 3.3-3.4-.5L12 22l-2.4-2.4-3.4.5-1-3.3-3-1.7L3.4 12 2.2 8.9l3-1.7 1-3.3 3.4.5L12 2zm-1.3 13.6l5.4-5.4-1.2-1.2-4.2 4.2-1.8-1.8-1.2 1.2 3 3z" />
            </svg>
          ) : null}
        </span>
        <span className="handle">@{tweet.authorHandle}</span>
        <a
          className="timestamp"
          href={`https://x.com/${tweet.authorHandle}/status/${tweet.tweetId}`}
          target="_blank"
          rel="noreferrer"
        >
          {formatDate(tweet.createdAt)}
        </a>
      </div>
      <p className="text">{highlight(tweet.text, terms)}</p>
      <Media tweet={tweet} />
      <p className="metrics">
        <span>{compact(tweet.likeCount)} likes</span>
        <span>{compact(tweet.retweetCount)} reposts</span>
        <span>{compact(tweet.replyCount)} replies</span>
        <span>{compact(tweet.quoteCount)} quotes</span>
        {queryKey !== null ? (
          <span className="votes">
            <button
              type="button"
              className={voted === 1 ? "vote on" : "vote"}
              aria-label="Good result for this search"
              onClick={() => {
                setVoted(1);
                void vote({ queryKey, tweetId: tweet._id, vote: 1, sessionId: sessionId() });
              }}
            >
              +1
            </button>
            <button
              type="button"
              className={voted === -1 ? "vote on" : "vote"}
              aria-label="Bad result for this search"
              onClick={() => {
                setVoted(-1);
                void vote({ queryKey, tweetId: tweet._id, vote: -1, sessionId: sessionId() });
              }}
            >
              -1
            </button>
          </span>
        ) : null}
      </p>
    </article>
  );
}

function Media({ tweet }: { tweet: Result }) {
  if (tweet.mediaType === "none" || tweet.mediaUrls.length === 0) return null;
  return (
    <div className={tweet.mediaUrls.length > 1 ? "media grid" : "media"}>
      {tweet.mediaUrls.map((url) =>
        tweet.mediaType === "image" ? (
          <img key={url} src={url} alt="" loading="lazy" />
        ) : (
          <video
            key={url}
            src={url}
            controls={tweet.mediaType === "video"}
            autoPlay={tweet.mediaType === "gif"}
            loop={tweet.mediaType === "gif"}
            muted
            playsInline
            preload="metadata"
          />
        ),
      )}
    </div>
  );
}

/** Underline literal hits — the terms that actually gated/boosted retrieval. */
function highlight(text: string, terms: string[]) {
  const words = terms
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0 && !w.startsWith("-") && !w.startsWith("~"));
  if (words.length === 0) return text;
  const parts = text.split(/(\s+)/);
  return parts.map((part, i) =>
    words.includes(part.toLowerCase().replace(/^[^\p{L}\p{N}#@$]+|[^\p{L}\p{N}]+$/gu, "")) ? (
      <mark key={i}>{part}</mark>
    ) : (
      part
    ),
  );
}

const formatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
function compact(n: number): string {
  return formatter.format(n);
}

function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

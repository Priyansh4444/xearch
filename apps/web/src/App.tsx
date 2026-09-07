import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";

type Results = FunctionReturnType<typeof api.search.searchBaseline>;
type Result = Results[number];

/** Known-dense corpus topics — each returns real posts from the archived run. */
const DEMO_QUERIES = ["bun", "pricing", "rust", "react server components", "agents"];

const DEBOUNCE_MS = 250;

export function App() {
  const initial = new URLSearchParams(window.location.search).get("q") ?? "";
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState(initial.trim());

  useEffect(() => {
    const handle = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [input]);

  // Keep the query shareable: /?q=... mirrors the search box.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query === "") url.searchParams.delete("q");
    else url.searchParams.set("q", query);
    window.history.replaceState(null, "", url);
  }, [query]);

  const results = useQuery(
    api.search.searchBaseline,
    query === "" ? "skip" : { raw: query },
  );

  // Keep the previous list on screen while a new query loads (no layout flash).
  const lastShown = useRef<{ query: string; results: Results } | null>(null);
  if (results !== undefined && query !== "") {
    lastShown.current = { query, results };
  }
  const shown = query === "" ? null : (results !== undefined ? results : lastShown.current?.results);
  const searching = query !== "" && results === undefined;

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
      </div>

      {query === "" ? (
        <Intro onPick={(q) => { setInput(q); setQuery(q); }} />
      ) : shown === undefined || shown === null ? (
        <SkeletonList />
      ) : shown.length === 0 ? (
        <EmptyState query={query} onPick={(q) => { setInput(q); setQuery(q); }} />
      ) : (
        <main aria-busy={searching}>
          <p className="count-line">
            {shown.length === 20 ? "top 20 posts" : `${shown.length} post${shown.length === 1 ? "" : "s"}`}
            {shown.length > 0 && shown.length < 20 ? " — every match in the corpus" : ""}
          </p>
          <ol className="results">
            {shown.map((t) => (
              <li key={t._id}>
                <ResultRow tweet={t} query={query} />
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

function ResultRow({ tweet, query }: { tweet: Result; query: string }) {
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
      <p className="text">{highlight(tweet.text, query)}</p>
      <Media tweet={tweet} />
      <p className="metrics">
        <span>{compact(tweet.likeCount)} likes</span>
        <span>{compact(tweet.retweetCount)} reposts</span>
        <span>{compact(tweet.replyCount)} replies</span>
        <span>{compact(tweet.quoteCount)} quotes</span>
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

/** Underline literal hits — this lane matches exact words, show exactly that. */
function highlight(text: string, query: string) {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
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

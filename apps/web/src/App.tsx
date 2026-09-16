import { startTransition, useEffect, useState, type KeyboardEvent, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { MediaType } from "../../../convex/contracts/media";
import { queryInputError } from "../../../convex/engine/constraints";
import { LadderLevel } from "../../../convex/engine/plan";
import { SortOrder } from "../../../convex/engine/xquery";

type SearchReturn = FunctionReturnType<typeof api.search.search>;
type BaselineResults = FunctionReturnType<typeof api.search.searchBaseline>;
type Result = BaselineResults[number] & {
  matchedVia?: SearchReturn["results"][number]["matchedVia"];
};
type Lane = "xearch" | "baseline";

interface Shown {
  error: string | null;
  results: Result[];
  ladder: SearchReturn["ladder"] | null;
  queryKey: string | null;
  /** Terms that actually gated/boosted retrieval — what highlighting should mark. */
  terms: string[];
  /** No indexed terms or filters: the posting index has nothing to retrieve on. */
  termless: boolean;
}

/** Known-dense corpus topics — each returns real posts from the archived run. */
const DEMO_QUERIES = ["bun", "pricing", "rust", "react server components", "agents"];

function useSearchPage() {
  const [initial] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      input: params.get("q") ?? "",
      query: (params.get("q") ?? "").trim(),
      sort: params.get("sort") === SortOrder.Latest ? SortOrder.Latest : SortOrder.Top,
      lane: params.get("lane") === "baseline" ? ("baseline" as const) : ("xearch" as const),
    };
  });
  const [input, setInput] = useState(initial.input);
  const [query, setQuery] = useState(initial.query);
  const [sort, setSort] = useState<SortOrder>(initial.sort);
  const [lane, setLane] = useState<Lane>(initial.lane);
  const inputError = queryInputError(query);
  const canVote = useQuery(api.feedback.canVote);

  // Keep the query shareable: /?q=...&sort=...&lane=... mirrors the controls.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query === "") url.searchParams.delete("q");
    else url.searchParams.set("q", query);
    if (sort === SortOrder.Top) url.searchParams.delete("sort");
    else url.searchParams.set("sort", sort);
    if (lane === "xearch") url.searchParams.delete("lane");
    else url.searchParams.set("lane", lane);
    window.history.replaceState(null, "", url);
  }, [query, sort, lane]);

  const full = useQuery(
    api.search.search,
    query === "" || inputError !== null || lane !== "xearch" ? "skip" : { raw: query, sort },
  );
  const baseline = useQuery(
    api.search.searchBaseline,
    query === "" || inputError !== null || lane !== "baseline" ? "skip" : { raw: query },
  );

  const current = presentResults(lane, query, full, baseline);

  const shown = input.trim() === query ? current : undefined;
  const error = inputError ?? shown?.error;
  const searching = input.trim() !== "" && !error && shown === undefined;
  const operatorSort = full !== undefined && Object.values(full.trace.consumed).includes("sort");
  const activeSort = full?.appliedQuery.sort ?? sort;

  const pickQuery = (next: string) => {
    setInput(next);
    startTransition(() => setQuery(next.trim()));
  };
  const changeInput = (next: string) => {
    setInput(next);
    startTransition(() => setQuery(next.trim()));
  };
  return {
    input,
    query,
    setSort,
    lane,
    setLane,
    shown,
    error,
    searching,
    operatorSort,
    activeSort,
    canVote: canVote === true,
    pickQuery,
    changeInput,
  };
}

function presentResults(
  lane: Lane,
  query: string,
  full: SearchReturn | undefined,
  baseline: BaselineResults | undefined,
): Shown | undefined {
  if (lane === "baseline") {
    return baseline === undefined
      ? undefined
      : {
          error: null,
          results: baseline,
          ladder: null,
          queryKey: null,
          terms: query.split(/\s+/),
          termless: false,
        };
  }
  if (full === undefined) return undefined;
  const q = full.appliedQuery;
  const f = q.filters;
  const termless =
    q.must.length === 0 &&
    q.should.length === 0 &&
    q.phrases.length === 0 &&
    q.exclude.length === 0 &&
    q.aspects.length === 0 &&
    f.authorId === null &&
    f.since === null &&
    f.until === null &&
    f.media === null &&
    f.minLikes === null &&
    f.lang === null;
  return {
    error: full.error,
    results: full.results,
    ladder: full.ladder,
    queryKey: full.queryKey,
    terms: [...q.must, ...q.should, ...q.phrases.flat(), ...q.exclude.map((term) => `-${term}`)],
    termless,
  };
}

export function App(): ReactElement {
  const {
    input,
    query,
    setSort,
    lane,
    setLane,
    shown,
    error,
    searching,
    operatorSort,
    activeSort,
    canVote,
    pickQuery,
    changeInput,
  } = useSearchPage();
  return (
    <div className="page">
      <header className="masthead">
        <h1 className="wordmark">xearch</h1>
        <p className="lane-note">literal lane: exact words, real posts</p>
      </header>

      <SearchBox input={input} searching={searching} onChange={changeInput} onPick={pickQuery} />

      {query !== "" ? (
        <div className="controls">
          <div className="tabs" role="tablist" aria-label="Sort">
            {([SortOrder.Top, SortOrder.Latest] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={activeSort === s}
                className={activeSort === s ? "tab active" : "tab"}
                onClick={() => setSort(s)}
                disabled={lane === "baseline" || operatorSort}
              >
                {s === SortOrder.Top ? "Top" : "Latest"}
              </button>
            ))}
          </div>
          {operatorSort ? <span>Remove the sort: operator to use the tabs.</span> : null}
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

      <SearchBody
        query={query}
        error={error}
        shown={shown}
        searching={searching}
        canVote={canVote}
        onPick={pickQuery}
        onUseLiteral={lane === "xearch" ? () => setLane("baseline") : null}
      />

      <footer className="colophon">
        <p>corpus: 62 seed timelines plus related posts, archived 2026-09-03. served by Convex.</p>
      </footer>
    </div>
  );
}

interface SearchBodyProps {
  query: string;
  error: string | null | undefined;
  shown: Shown | undefined;
  searching: boolean;
  canVote: boolean;
  onPick: (query: string) => void;
  onUseLiteral: (() => void) | null;
}

function SearchBody({
  query,
  error,
  shown,
  searching,
  canVote,
  onPick,
  onUseLiteral,
}: SearchBodyProps): ReactElement {
  if (query === "") return <Intro onPick={onPick} />;
  if (error) return <p role="alert">{error}</p>;
  if (shown === undefined) return <SkeletonList />;
  if (shown.results.length === 0)
    return (
      <EmptyState
        query={query}
        onPick={onPick}
        onUseLiteral={shown.termless ? onUseLiteral : null}
      />
    );

  const count = shown.results.length;
  let countLabel = `${count} posts`;
  if (count === 1) countLabel = "1 post";
  if (count === 20) countLabel = "top 20 posts";
  let notice = "";
  if (shown.ladder !== null && shown.ladder !== LadderLevel.L0) {
    notice = ` — exact matches were thin; widened to related posts (${shown.ladder})`;
  } else if (count < 20) {
    notice = " — matches within the bounded search window";
  }
  const exact: Result[] = [];
  const related: Result[] = [];
  for (const tweet of shown.results) {
    if (tweet.matchedVia === undefined || tweet.matchedVia === LadderLevel.L0) exact.push(tweet);
    else related.push(tweet);
  }
  const renderList = (rows: Result[], label: string) => (
    <ol className="results" aria-label={label}>
      {rows.map((tweet) => (
        <li key={`${shown.queryKey ?? query}:${tweet._id}`}>
          <ResultRow tweet={tweet} terms={shown.terms} queryKey={canVote ? shown.queryKey : null} />
        </li>
      ))}
    </ol>
  );
  return (
    <main aria-busy={searching}>
      <p className="count-line">
        {countLabel}
        {notice}
      </p>
      {exact.length > 0 ? renderList(exact, "Exact matches") : null}
      {related.length > 0 ? (
        <>
          <h2 className="related-label">Related</h2>
          {renderList(related, "Related posts")}
        </>
      ) : null}
    </main>
  );
}

function Intro({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="intro">
      <p>
        Type a query to search the indexed corpus. Every result is a real post; nothing is mocked.
        Try one:
      </p>
      <DemoChips onPick={onPick} />
    </div>
  );
}

function EmptyState({
  query,
  onPick,
  onUseLiteral,
}: {
  query: string;
  onPick: (q: string) => void;
  onUseLiteral: (() => void) | null;
}) {
  if (onUseLiteral !== null) {
    return (
      <div className="empty-state">
        <p>
          Every word in <span className="query-echo">{query}</span> is dropped by the posting index,
          so this lane has nothing to retrieve on. The literal lane searches those words directly:
        </p>
        <button type="button" className="lane-toggle" onClick={onUseLiteral}>
          search the literal lane
        </button>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <p>
        No matches found in the bounded search window for{" "}
        <span className="query-echo">{query}</span>. The corpus starts from 62 tech accounts — try
        words people actually posted:
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

function SearchBox({
  input,
  searching,
  onChange,
  onPick,
}: {
  input: string;
  searching: boolean;
  onChange: (next: string) => void;
  onPick: (query: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [nav, setNav] = useState<{
    prefix: string;
    mode: "term" | "author" | "both";
    i: number;
  }>({ prefix: "", mode: "both", i: 0 });
  const { prefix, mode, current } = suggestToken(input);
  const minLen = mode === "author" ? 1 : 2;
  const suggestions = useQuery(
    api.search.suggest,
    open && prefix.length >= minLen ? { prefix, mode } : "skip",
  );
  const rows = (suggestions ?? [])
    .filter((s) => s.term !== prefix && s.term !== current)
    .slice(0, 8);
  const active = nav.prefix === prefix && nav.mode === mode ? nav.i : 0;
  const pick = (term: string) => {
    onPick(applySuggestion(input, term));
    setOpen(false);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || rows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setNav({ prefix, mode, i: (active + 1) % rows.length });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setNav({ prefix, mode, i: (active - 1 + rows.length) % rows.length });
    } else if (event.key === "Enter") {
      const row = rows[active];
      if (row !== undefined) {
        event.preventDefault();
        pick(row.term);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };
  return (
    <div className={searching ? "searchbox is-searching" : "searchbox"}>
      <input
        type="search"
        value={input}
        onChange={(e) => {
          setOpen(true);
          onChange(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 0);
        }}
        onKeyDown={onKey}
        placeholder="search 164,959 posts"
        aria-label="Search posts"
        aria-autocomplete="list"
        aria-expanded={open && rows.length > 0}
        aria-controls="suggest-list"
        aria-activedescendant={
          open && rows[active] !== undefined ? `suggest-${String(active)}` : undefined
        }
      />
      {open && rows.length > 0 ? (
        <ul className="typeahead" id="suggest-list" role="listbox" aria-label="Suggestions">
          {rows.map((s, i) => (
            <li key={`${s.kind}:${s.term}`}>
              <button
                type="button"
                id={`suggest-${String(i)}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(s.term)}
              >
                <span>{s.kind === "author" ? `@${s.term}` : applySuggestion(input, s.term)}</span>
                <span className="df">{s.kind === "author" ? "account" : s.df}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Last whitespace-delimited token, with from:/@ stripped for the suggest prefix. */
export function suggestToken(input: string): {
  prefix: string;
  mode: "term" | "author" | "both";
  current: string;
} {
  const current = input.split(/\s+/).at(-1) ?? "";
  const from = /^from:@?/i.exec(current);
  if (from !== null) {
    return { prefix: current.slice(from[0].length).toLowerCase(), mode: "author", current };
  }
  if (current.startsWith("@")) {
    return { prefix: current.slice(1).toLowerCase(), mode: "author", current };
  }
  return { prefix: current.toLowerCase(), mode: "both", current };
}

function applySuggestion(input: string, term: string): string {
  const parts = input.split(/\s+/);
  const last = parts.at(-1) ?? "";
  let next = term;
  if (/^from:/i.test(last)) {
    next = last.toLowerCase().includes("@") ? `from:@${term}` : `from:${term}`;
  } else if (last.startsWith("@")) {
    next = `@${term}`;
  }
  return [...parts.slice(0, -1), next].join(" ");
}

interface ResultRowProps {
  tweet: Result;
  terms: string[];
  queryKey: string | null;
}

function ResultRow({ tweet, terms, queryKey }: ResultRowProps): ReactElement {
  const vote = useMutation(api.feedback.vote);
  const [voted, setVoted] = useState<1 | -1 | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);
  async function submitVote(value: 1 | -1): Promise<void> {
    if (queryKey === null) return;
    setVoting(true);
    setVoteError(null);
    try {
      await vote({ queryKey, tweetId: tweet._id, vote: value });
      setVoted(value);
    } catch (error: unknown) {
      const message =
        error instanceof ConvexError && typeof error.data === "string"
          ? error.data
          : "Vote failed. Please try again.";
      setVoteError(message);
    } finally {
      setVoting(false);
    }
  }
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
              disabled={voting}
              onClick={() => {
                void submitVote(1);
              }}
            >
              +1
            </button>
            <button
              type="button"
              className={voted === -1 ? "vote on" : "vote"}
              aria-label="Bad result for this search"
              disabled={voting}
              onClick={() => {
                void submitVote(-1);
              }}
            >
              -1
            </button>
          </span>
        ) : null}
      </p>
      {voteError !== null ? <p role="alert">{voteError}</p> : null}
    </article>
  );
}

function Media({ tweet }: { tweet: Result }) {
  if (tweet.mediaType === MediaType.None || tweet.mediaUrls.length === 0) return null;
  return (
    <div className={tweet.mediaUrls.length > 1 ? "media grid" : "media"}>
      {tweet.mediaUrls.map((url) =>
        tweet.mediaType === MediaType.Image ? (
          <img key={url} src={url} alt="" loading="lazy" />
        ) : (
          <video
            key={url}
            src={url}
            controls={tweet.mediaType === MediaType.Video}
            autoPlay={tweet.mediaType === MediaType.Gif}
            loop={tweet.mediaType === MediaType.Gif}
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
  const words = new Set<string>();
  for (const term of terms) {
    const word = term.toLowerCase();
    if (word.length > 0 && !word.startsWith("-") && !word.startsWith("~")) {
      words.add(word);
    }
  }
  if (words.size === 0) return text;
  const parts = text.split(/(\s+)/);
  let markId = 0;
  return parts.map((part) => {
    const normalized = part.toLowerCase().replace(/^[^\p{L}\p{N}#@$]+|[^\p{L}\p{N}]+$/gu, "");
    if (!words.has(normalized)) return part;
    markId += 1;
    return <mark key={`${normalized}-${markId}`}>{part}</mark>;
  });
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

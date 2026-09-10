import { startTransition, useEffect, useRef, useState, type ReactElement } from "react";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { MediaType } from "../../../convex/contracts/media";
import { queryInputError } from "../../../convex/engine/constraints";
import { LadderLevel } from "../../../convex/engine/plan";
import { SortOrder } from "../../../convex/engine/xquery";
import { tierA } from "../../../convex/engine/parse";
import { tokenize } from "../../../convex/engine/tokenize";

type SearchReturn = FunctionReturnType<typeof api.search.search>;
type BaselineResults = FunctionReturnType<typeof api.search.searchBaselinePage>["page"];
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
  /** Tier C upgrade applied to this SERP, when a queryCache row landed. */
  refined: SearchReturn["refined"];
}

/** Known-dense corpus topics — each returns real posts from the archived run. */
const DEMO_QUERIES = ["bun", "pricing", "rust", "react server components", "agents"];

/**
 * Every word is a stopword ("and so is"). The posting index skips stopwords, so
 * that lane has nothing to retrieve on; the literal lane keeps them. Checked here
 * from the same tokenizer the backend uses, so the hint cannot drift.
 */
function isStopwordOnly(raw: string): boolean {
  return (
    raw.trim() !== "" && tokenize(raw).tokens.length === 0 && tokenize(raw, true).tokens.length > 0
  );
}

function useSearchPage() {
  const [initial] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      input: params.get("q") ?? "",
      query: (params.get("q") ?? "").trim(),
      sort: params.get("sort") === SortOrder.Latest ? SortOrder.Latest : SortOrder.Top,
      lane: params.get("lane") === "xearch" ? ("xearch" as const) : ("baseline" as const),
    };
  });
  const [input, setInput] = useState(initial.input);
  const [query, setQuery] = useState(initial.query);
  const [sort, setSort] = useState<SortOrder>(initial.sort);
  const [lane, setLane] = useState<Lane>(initial.lane);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const requestStartedAt = useRef(0);
  const requestSequence = useRef(0);
  const measuredSequence = useRef(-1);
  const inputError = queryInputError(query);
  const canVote = useQuery(api.feedback.canVote);

  // Keep the query shareable: /?q=...&sort=...&lane=... mirrors the controls.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query === "") url.searchParams.delete("q");
    else url.searchParams.set("q", query);
    if (sort === SortOrder.Top) url.searchParams.delete("sort");
    else url.searchParams.set("sort", sort);
    if (lane === "baseline") url.searchParams.delete("lane");
    else url.searchParams.set("lane", lane);
    window.history.replaceState(null, "", url);
  }, [query, sort, lane]);

  const full = useQuery(
    api.search.search,
    query === "" || inputError !== null || lane !== "xearch" ? "skip" : { raw: query, sort },
  );
  const baselineArgs = { raw: query, sort };
  const baseline = usePaginatedQuery(
    api.search.searchBaselinePage,
    query === "" || inputError !== null || lane !== "baseline" ? "skip" : baselineArgs,
    { initialNumItems: 20 },
  );
  const baselineResults = baseline.status === "LoadingFirstPage" ? undefined : baseline.results;

  const current = presentResults(lane, query, full, baselineResults);

  const shown = input.trim() === query ? current : undefined;
  const error = inputError ?? shown?.error;
  const searching = input.trim() !== "" && error == null && shown === undefined;
  const literal = tierA(query);
  const operatorSort = Object.values(literal.trace.consumed).includes("sort");
  const activeSort = operatorSort ? literal.xq.sort : (full?.appliedQuery.sort ?? sort);

  useEffect(() => {
    requestStartedAt.current = performance.now();
  }, []);

  useEffect(() => {
    if (
      query !== "" &&
      input.trim() === query &&
      current !== undefined &&
      measuredSequence.current !== requestSequence.current
    ) {
      measuredSequence.current = requestSequence.current;
      setLatencyMs(performance.now() - requestStartedAt.current);
    }
  }, [current, input, query]);

  const beginRequest = () => {
    requestStartedAt.current = performance.now();
    requestSequence.current += 1;
    setLatencyMs(null);
  };
  const runQuery = (next: string) => {
    beginRequest();
    startTransition(() => setQuery(next.trim()));
  };
  const pickQuery = (next: string) => {
    setInput(next);
    runQuery(next);
  };
  const changeInput = (next: string) => {
    setInput(next);
  };
  useEffect(() => {
    const next = input.trim();
    if (next === query) return;
    const timer = window.setTimeout(() => runQuery(next), 150);
    return () => window.clearTimeout(timer);
  }, [input, query]);
  const changeSort = (next: SortOrder) => {
    beginRequest();
    setSort(next);
  };
  const changeLane = (next: Lane) => {
    beginRequest();
    setLane(next);
  };
  return {
    input,
    query,
    setSort: changeSort,
    lane,
    setLane: changeLane,
    shown,
    error,
    searching,
    operatorSort,
    activeSort,
    canVote: canVote === true,
    latencyMs,
    baselineStatus: baseline.status,
    loadMoreBaseline: () => {
      beginRequest();
      baseline.loadMore(20);
    },
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
          refined: null,
        };
  }
  if (full === undefined) return undefined;
  const q = full.appliedQuery;
  return {
    error: full.error,
    results: full.results,
    ladder: full.ladder,
    queryKey: full.queryKey,
    terms: [...q.must, ...q.should, ...q.phrases.flat(), ...q.exclude.map((term) => `-${term}`)],
    refined: full.refined,
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
    latencyMs,
    baselineStatus,
    loadMoreBaseline,
    pickQuery,
    changeInput,
  } = useSearchPage();
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
          onChange={(e) => changeInput(e.target.value)}
          placeholder="search archived posts"
          aria-label="Search posts"
        />
        {/* Only while the input is ahead of the executed query — typing, not idle. */}
        {input.trim() !== query ? <Typeahead input={input} onPick={pickQuery} /> : null}
      </div>

      <InterpretControl
        key={query}
        query={query}
        onApply={(next) => {
          setLane("baseline");
          pickQuery(next);
        }}
      />

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
                disabled={operatorSort}
              >
                {s === SortOrder.Top ? "Top" : lane === "baseline" ? "Recent" : "Latest"}
              </button>
            ))}
          </div>
          {operatorSort ? <span>Remove the sort: operator to use the tabs.</span> : null}
          {lane === "baseline" && activeSort === SortOrder.Latest ? (
            <span>Newest within the bounded relevance window, not the entire archive.</span>
          ) : null}
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
        lane={lane}
        error={error}
        shown={shown}
        searching={searching}
        canVote={canVote}
        latencyMs={latencyMs}
        baselineStatus={lane === "baseline" ? baselineStatus : null}
        onLoadMore={loadMoreBaseline}
        onPick={pickQuery}
        onUseLiteralLane={() => setLane("baseline")}
      />
      {query === "" ? <ArrivalFeed /> : null}

      <footer className="colophon">
        <p>archived timelines and related posts. served by Convex.</p>
      </footer>
    </div>
  );
}

function InterpretControl({ query, onApply }: { query: string; onApply: (query: string) => void }) {
  const request = useAction(api.interpret.request);
  const [result, setResult] = useState<FunctionReturnType<typeof api.interpret.request> | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  if (query === "") return null;
  async function interpret() {
    setPending(true);
    setResult(null);
    try {
      setResult(await request({ raw: query }));
    } catch {
      setResult({
        status: "error",
        message: "Interpretation unavailable. Your original search is unchanged.",
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="Query interpretation">
      <button type="button" disabled={pending} onClick={() => void interpret()}>
        {pending ? "Interpreting…" : "Interpret with AI"}
      </button>
      <p>Optional query rewrite only. Never runs while typing; review before applying.</p>
      {result?.status === "ready" ? (
        <div>
          <p>
            Suggested search: <code>{result.query}</code>
          </p>
          <button type="button" onClick={() => onApply(result.query)}>
            Apply interpretation
          </button>
        </div>
      ) : result !== null ? (
        <p role="status">{result.message}</p>
      ) : null}
    </section>
  );
}

function ArrivalFeed() {
  const [enabled, setEnabled] = useState(false);
  const rows = useQuery(api.feed.recent, enabled ? {} : "skip");
  return (
    <section aria-label="Live arrivals">
      <h2>Live arrivals</h2>
      <p>
        Newly ingested archive posts, updated by Convex subscriptions. This is not an X firehose. No
        new collection starts here.
      </p>
      <button type="button" onClick={() => setEnabled(!enabled)}>
        {enabled ? "Pause arrivals" : "Watch arrivals"}
      </button>
      {enabled && rows === undefined ? <p role="status">Connecting to arrivals…</p> : null}
      {enabled && rows?.length === 0 ? <p>No posts ingested yet. Waiting for arrivals.</p> : null}
      {enabled && rows !== undefined ? (
        <ol className="results">
          {rows.map((tweet) => (
            <li key={tweet._id}>
              <ResultRow tweet={tweet} terms={[]} queryKey={null} />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

interface SearchBodyProps {
  query: string;
  lane: Lane;
  error: string | null | undefined;
  shown: Shown | undefined;
  searching: boolean;
  canVote: boolean;
  latencyMs: number | null;
  baselineStatus: "CanLoadMore" | "LoadingMore" | "Exhausted" | "LoadingFirstPage" | null;
  onLoadMore: () => void;
  onPick: (query: string) => void;
  onUseLiteralLane: () => void;
}

function SearchBody({
  query,
  lane,
  error,
  shown,
  searching,
  canVote,
  latencyMs,
  baselineStatus,
  onLoadMore,
  onPick,
  onUseLiteralLane,
}: SearchBodyProps): ReactElement {
  if (query === "") return <Intro onPick={onPick} />;
  if (error !== null && error !== undefined)
    return (
      <>
        <p role="alert">{error}</p>
        {canVote ? <QueryReport query={query} lane={lane} reason="error" /> : null}
      </>
    );
  if (shown === undefined) return <SkeletonList />;
  if (shown.results.length === 0 && baselineStatus === "CanLoadMore") {
    return (
      <main>
        <p>No exact matches in this candidate page.</p>
        <button type="button" onClick={onLoadMore}>
          Search next page
        </button>
      </main>
    );
  }
  if (shown.results.length === 0)
    return (
      <>
        <EmptyState
          query={query}
          stopwordOnly={lane === "xearch" && isStopwordOnly(query)}
          onPick={onPick}
          onUseLiteralLane={onUseLiteralLane}
        />
        {canVote ? <QueryReport query={query} lane={lane} reason="no-results" /> : null}
      </>
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
  return (
    <main aria-busy={searching}>
      <p className="count-line">
        {countLabel}
        {notice}
        {shown.refined !== null
          ? ` — interpretation refined (${shown.refined.source}): ${shown.refined.filled.join(", ")}`
          : ""}
        {latencyMs === null ? "" : ` — ${Math.round(latencyMs)} ms client`}
      </p>
      <ol className="results">
        {shown.results.map((tweet) => (
          <li key={`${shown.queryKey ?? query}:${tweet._id}`}>
            <ResultRow
              tweet={tweet}
              terms={shown.terms}
              queryKey={canVote ? shown.queryKey : null}
            />
          </li>
        ))}
      </ol>
      {baselineStatus === "CanLoadMore" || baselineStatus === "LoadingMore" ? (
        <button type="button" disabled={baselineStatus === "LoadingMore"} onClick={onLoadMore}>
          {baselineStatus === "LoadingMore" ? "Loading more…" : "Load more"}
        </button>
      ) : null}
      {canVote ? <QueryReport query={query} lane={lane} reason="bad-results" /> : null}
    </main>
  );
}

function QueryReport({
  query,
  lane,
  reason,
}: {
  query: string;
  lane: Lane;
  reason: "bad-results" | "no-results" | "error";
}) {
  const report = useMutation(api.feedback.reportQuery);
  const [status, setStatus] = useState<"idle" | "sending" | "recorded" | "failed">("idle");
  async function send() {
    setStatus("sending");
    try {
      await report({ raw: query, lane, reason });
      setStatus("recorded");
    } catch {
      setStatus("failed");
    }
  }
  return (
    <div>
      <button type="button" disabled={status !== "idle"} onClick={() => void send()}>
        {status === "recorded"
          ? "Search reported"
          : status === "sending"
            ? "Reporting…"
            : "Report bad search"}
      </button>
      {status === "failed" ? <span role="alert">Could not report this search.</span> : null}
    </div>
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
  stopwordOnly,
  onPick,
  onUseLiteralLane,
}: {
  query: string;
  stopwordOnly: boolean;
  onPick: (q: string) => void;
  onUseLiteralLane: () => void;
}) {
  return (
    <div className="empty-state">
      <p>
        No matches found in the bounded search window for{" "}
        <span className="query-echo">{query}</span>.{" "}
        {stopwordOnly
          ? "Every word in this query is a stopword, so the posting index has no entries for it."
          : "The corpus starts from 62 tech accounts — try words people actually posted:"}
      </p>
      {stopwordOnly ? (
        <button type="button" onClick={onUseLiteralLane}>
          Search the literal lane
        </button>
      ) : (
        <DemoChips onPick={onPick} />
      )}
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
  const complete = (term: string) => [...input.split(/\s+/).slice(0, -1), term].join(" ");
  return (
    <ul className="typeahead" role="listbox" aria-label="Suggestions">
      {suggestions
        .filter((s) => s.term !== lastWord)
        .slice(0, 5)
        .map((s) => (
          <li key={s.term}>
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => onPick(complete(s.term))}
            >
              {complete(s.term)}
              <span className="df">{s.df}</span>
            </button>
          </li>
        ))}
    </ul>
  );
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
          {tweet.author?.verified === true ? (
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

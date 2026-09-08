// FxTwitter HTTP client (docs/COLLECTION.md §2). Owns retries, timeouts, and the
// documented response envelopes. It never interprets a response into ingress
// records; that is normalization's job (apps/collector/src/normalization).

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";

const DEFAULT_BASE_URL = "https://api.fxtwitter.com";
const USER_AGENT = "xearch-collection-pilot/0.2";

export interface FxTwitterCursor {
  top: string | null;
  bottom: string | null;
}

export interface FxTwitterTimelinePage {
  code: number;
  results: ReadonlyArray<FxTwitterTimelineResult>;
  cursor: FxTwitterCursor;
}

const TimelineResultSchema = Schema.JsonObject;
export type FxTwitterTimelineResult = Schema.Schema.Type<typeof TimelineResultSchema>;

/** Minimal profile fields acquisition needs for identity resolution. */
export interface FxTwitterProfile {
  id: string;
  screenName: string;
  name: string;
  protected: boolean;
}

export interface TimelineRequest {
  /** A handle (`NASA`) or a stable numeric reference (`id:11348282`). */
  handle: string;
  count: number;
  cursor: string | null;
  withReplies: boolean;
}

export interface TimelineResponse {
  httpStatus: number;
  latencyMs: number;
  attempts: number;
  /** Wall-clock epoch ms when the final successful response arrived. */
  receivedAt: number;
  raw: unknown;
  page: FxTwitterTimelinePage | null;
}

export interface ProfileResponse {
  httpStatus: number;
  latencyMs: number;
  attempts: number;
  receivedAt: number;
  raw: unknown;
  /** Null when the provider answered 404 (no such profile). */
  profile: FxTwitterProfile | null;
}

export interface TimelineClient {
  fetchTimelinePage(request: TimelineRequest): Promise<TimelineResponse>;
}

export interface ProfileClient {
  fetchProfile(handle: string): Promise<ProfileResponse>;
}

export type PilotClient = TimelineClient & ProfileClient;

export interface FxTwitterClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

export type FxTwitterErrorKind = "transport" | "http" | "decode";

export class FxTwitterError extends Data.TaggedError("FxTwitterError")<{
  readonly message: string;
  readonly status: number | null;
  readonly responseBody: string | null;
  readonly kind: FxTwitterErrorKind;
  readonly retryDelay: number;
}> {}

const TimelinePageSchema = Schema.Struct({
  code: Schema.Number,
  results: Schema.Array(TimelineResultSchema),
  cursor: Schema.Struct({
    top: Schema.NullOr(Schema.String),
    bottom: Schema.NullOr(Schema.String),
  }),
});

const ProfileEnvelopeSchema = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    screen_name: Schema.String,
    name: Schema.optional(Schema.String),
    protected: Schema.optional(Schema.Boolean),
  }),
});

interface RawResponse {
  httpStatus: number;
  latencyMs: number;
  attempts: number;
  receivedAt: number;
  bodyText: string | null;
}

export class FxTwitterClient implements PilotClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: ((delayMs: number) => Promise<void>) | undefined;
  private readonly now: () => number;

  constructor(options: FxTwitterClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep;
    this.now = options.now ?? Date.now;
  }

  timelineUrl(request: TimelineRequest): string {
    const url = new URL(`${this.baseUrl}/2/profile/${encodeURIComponent(request.handle)}/statuses`);
    url.searchParams.set("count", String(request.count));
    if (request.cursor !== null) url.searchParams.set("cursor", request.cursor);
    if (request.withReplies) url.searchParams.set("with_replies", "true");
    return url.toString();
  }

  profileUrl(handle: string): string {
    return `${this.baseUrl}/2/profile/${encodeURIComponent(handle)}`;
  }

  async fetchTimelinePage(request: TimelineRequest): Promise<TimelineResponse> {
    return Effect.runPromise(this.fetchTimelinePageEffect(request));
  }

  fetchTimelinePageEffect(request: TimelineRequest): Effect.Effect<TimelineResponse, FxTwitterError> {
    return Effect.flatMap(
      this.request(this.timelineUrl(request), { allowNoContent: true, allowNotFound: false }),
      (response) => Effect.try({
        try: () => {
          if (response.bodyText === null) return { ...response, raw: null, page: null };
          const parsed = parseJson(response.bodyText);
          return { ...response, raw: parsed, page: parseTimelinePage(parsed) };
        },
        catch: decodeError,
      }),
    );
  }

  async fetchProfile(handle: string): Promise<ProfileResponse> {
    return Effect.runPromise(this.fetchProfileEffect(handle));
  }

  fetchProfileEffect(handle: string): Effect.Effect<ProfileResponse, FxTwitterError> {
    return Effect.flatMap(
      this.request(this.profileUrl(handle), { allowNoContent: false, allowNotFound: true }),
      (response) => Effect.try({
        try: () => {
          if (response.httpStatus === 404) {
            const raw = response.bodyText === null ? null : tryParseJson(response.bodyText);
            return { ...response, raw, profile: null };
          }
          const parsed = parseJson(response.bodyText ?? "");
          return { ...response, raw: parsed, profile: parseProfile(parsed) };
        },
        catch: decodeError,
      }),
    );
  }

  private request(
    url: string,
    options: { allowNoContent: boolean; allowNotFound: boolean },
  ): Effect.Effect<RawResponse, FxTwitterError> {
    // Mutable attempt state belongs to one execution, not to the reusable Effect.
    return Effect.suspend(() => {
      const startedAt = performance.now();
      let attempt = 0;
      const once = Effect.tryPromise({
        try: async (signal): Promise<RawResponse> => {
        attempt += 1;
        const response = await this.fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": USER_AGENT },
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        });
        const receivedAt = this.now();

        if (response.status === 204 && options.allowNoContent) {
          return {
            httpStatus: 204,
            latencyMs: performance.now() - startedAt,
            attempts: attempt,
            receivedAt,
            bodyText: null,
          };
        }

        const bodyText = await response.text();
        if (response.status === 404 && options.allowNotFound) {
          return {
            httpStatus: 404,
            latencyMs: performance.now() - startedAt,
            attempts: attempt,
            receivedAt,
            bodyText,
          };
        }
        if (!response.ok) {
          throw new FxTwitterError({
            message: `FxTwitter returned HTTP ${response.status}`,
            status: response.status,
            responseBody: bodyText,
            kind: "http",
            retryDelay: retryDelayMs(response, attempt, this.retryBaseDelayMs),
          });
        }
        return {
          httpStatus: response.status,
          latencyMs: performance.now() - startedAt,
          attempts: attempt,
          receivedAt,
          bodyText,
        };
        },
        catch: (cause) => cause instanceof FxTwitterError ? cause : new FxTwitterError({
          message: `FxTwitter request failed on attempt ${attempt}: ${errorMessage(cause)}`,
          status: null,
          responseBody: null,
          kind: "transport",
          retryDelay: exponentialDelayMs(attempt, this.retryBaseDelayMs),
        }),
      });
      return Effect.retry(once, {
        while: (error) => {
          const retryable = error.kind === "transport"
            || (error.kind === "http" && error.status !== null && isRetryableStatus(error.status));
          if (!retryable || attempt > this.retries) return Effect.succeed(false);
          const sleep = this.sleep;
          if (sleep === undefined) return Effect.as(Effect.sleep(error.retryDelay), true);
          return Effect.as(Effect.tryPromise({
            try: () => sleep(error.retryDelay),
            catch: (cause) => new FxTwitterError({
              message: `Retry wait failed: ${errorMessage(cause)}`,
              status: null,
              responseBody: null,
              kind: "transport",
              retryDelay: 0,
            }),
          }), true);
        },
      });
    });
  }
}

export function parseTimelinePage(value: unknown): FxTwitterTimelinePage {
  try {
    return Schema.decodeUnknownSync(TimelinePageSchema)(value);
  } catch (cause) {
    throw decodeError(cause, "timeline");
  }
}

export function parseProfile(value: unknown): FxTwitterProfile {
  try {
    const envelope = Schema.decodeUnknownSync(ProfileEnvelopeSchema)(value);
    return {
      id: envelope.user.id,
      screenName: envelope.user.screen_name,
      name: envelope.user.name ?? "",
      protected: envelope.user.protected ?? false,
    };
  } catch (cause) {
    throw decodeError(cause, "profile");
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new FxTwitterError({
      message: "FxTwitter returned invalid JSON",
      status: 200,
      responseBody: body,
      kind: "decode",
      retryDelay: 0,
    });
  }
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  return exponentialDelayMs(attempt, baseDelayMs);
}

function exponentialDelayMs(attempt: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeError(cause: unknown, resource = "response"): FxTwitterError {
  return cause instanceof FxTwitterError
    ? cause
    : new FxTwitterError({
      message: `FxTwitter ${resource} decode failed: ${errorMessage(cause)}`,
      status: 200,
      responseBody: null,
      kind: "decode",
      retryDelay: 0,
    });
}

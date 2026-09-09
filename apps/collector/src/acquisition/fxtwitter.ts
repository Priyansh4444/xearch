// FxTwitter HTTP client (docs/COLLECTION.md §2). Owns retries, timeouts, and the
// documented response envelopes. It never interprets a response into ingress
// records; that is normalization's job (apps/collector/src/normalization).

import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DEFAULT_BASE_URL = "https://api.fxtwitter.com";
const USER_AGENT = "xearch-collection-pilot/0.2";

export interface FxTwitterCursor {
  top: string | null;
  bottom: string | null;
}

export interface FxTwitterTimelinePage {
  code: number;
  results: ReadonlyArray<FxTwitterJson>;
  cursor: FxTwitterCursor;
}

export type FxTwitterJson = Schema.Schema.Type<typeof Schema.Json>;

export const FxTwitterTimelineStatusSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        screen_name: Schema.optional(Schema.String),
        name: Schema.optional(Schema.String),
        followers: Schema.optional(Schema.Number),
        following: Schema.optional(Schema.Number),
        joined: Schema.optional(Schema.Json),
        verification: Schema.optional(
          Schema.NullOr(Schema.Struct({ verified: Schema.optional(Schema.Boolean) })),
        ),
      }),
    ),
  ),
  created_timestamp: Schema.optional(Schema.Json),
  created_at: Schema.optional(Schema.String),
  likes: Schema.optional(Schema.Number),
  reposts: Schema.optional(Schema.Number),
  quotes: Schema.optional(Schema.Number),
  replies: Schema.optional(Schema.Number),
  reposted_by: Schema.optional(Schema.Json),
  quote: Schema.optional(Schema.Json),
  replying_to: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        screen_name: Schema.optional(Schema.String),
        status: Schema.optional(Schema.String),
      }),
    ),
  ),
  media: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        all: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                type: Schema.optional(Schema.String),
                url: Schema.optional(Schema.String),
              }),
            ),
          ),
        ),
      }),
    ),
  ),
});
export type FxTwitterTimelineStatus = Schema.Schema.Type<typeof FxTwitterTimelineStatusSchema>;

export function parseTimelineStatus(value: unknown): FxTwitterTimelineStatus | null {
  const parsed = Schema.decodeUnknownOption(FxTwitterTimelineStatusSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

/** Minimal profile fields acquisition needs for identity resolution. */
export interface FxTwitterProfile {
  id: string;
  screenName: string;
  name: string;
  protected: boolean;
  followers?: number;
  statuses?: number;
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
  raw: FxTwitterJson | null;
  page: FxTwitterTimelinePage | null;
}

export interface ProfileResponse {
  httpStatus: number;
  latencyMs: number;
  attempts: number;
  receivedAt: number;
  raw: FxTwitterJson | null;
  /** Null when the provider answered 404 (no such profile). */
  profile: FxTwitterProfile | null;
}

export const FxTwitterErrorKind = {
  Transport: "transport",
  Http: "http",
  Decode: "decode",
} as const;
export type FxTwitterErrorKind = (typeof FxTwitterErrorKind)[keyof typeof FxTwitterErrorKind];

export class FxTwitterError extends Data.TaggedError("FxTwitterError")<{
  readonly message: string;
  readonly status: number | null;
  readonly responseBody: string | null;
  readonly kind: FxTwitterErrorKind;
  readonly retryDelay: number;
}> {}

export interface TimelineClient {
  readonly baseUrl: string;
  timelineUrl(request: TimelineRequest): string;
  fetchTimelinePage(request: TimelineRequest): Promise<TimelineResponse>;
  fetchTimelinePageEffect(
    request: TimelineRequest,
  ): Effect.Effect<TimelineResponse, FxTwitterError>;
}

export interface ProfileClient {
  profileUrl(handle: string): string;
  fetchProfile(handle: string): Promise<ProfileResponse>;
  fetchProfileEffect(handle: string): Effect.Effect<ProfileResponse, FxTwitterError>;
}

export type PilotClient = TimelineClient & ProfileClient;

/** Dependency-injection seam for the acquisition client. Only introduced where
 * it helps tests: layers let specs swap a fake transport (and TestClock) with
 * `Effect.provide`, instead of threading options through every call site. */
export class FxTwitter extends Context.Service<FxTwitter, PilotClient>()("FxTwitter") {}

/** Production layer: a real client from options. */
export function FxTwitterLive(options: FxTwitterClientOptions = {}): Layer.Layer<FxTwitter> {
  return Layer.succeed(FxTwitter, makeFxTwitterClient(options));
}

/** Test layer: a client over a fake `fetch` (pair with TestClock for sleeps). */
export function FxTwitterTest(
  fetchImpl: typeof fetch,
  options: Omit<FxTwitterClientOptions, "fetchImpl"> = {},
): Layer.Layer<FxTwitter> {
  return Layer.succeed(FxTwitter, makeFxTwitterClient({ ...options, fetchImpl }));
}

export interface FxTwitterClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

interface FxTwitterConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryBaseDelayMs: number;
  readonly fetchImpl: typeof fetch;
  readonly sleep: ((delayMs: number) => Promise<void>) | undefined;
  readonly now: () => number;
}

interface RawResponse {
  httpStatus: number;
  latencyMs: number;
  attempts: number;
  receivedAt: number;
  bodyText: string | null;
}

const TimelinePageSchema = Schema.Struct({
  code: Schema.Number,
  results: Schema.Array(Schema.Json),
  cursor: Schema.Struct({
    top: Schema.NullOr(Schema.String),
    bottom: Schema.NullOr(Schema.String),
  }),
});

export const FxTwitterProfileEnvelopeSchema = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1)),
    screen_name: Schema.String,
    name: Schema.optional(Schema.String),
    protected: Schema.optional(Schema.Boolean),
    followers: Schema.optional(Schema.Number),
    statuses: Schema.optional(Schema.Number),
  }),
});
export type FxTwitterProfileEnvelope = Schema.Schema.Type<typeof FxTwitterProfileEnvelopeSchema>;

/** Build a PilotClient from closed-over config. No class instance state. */
export function makeFxTwitterClient(options: FxTwitterClientOptions = {}): PilotClient {
  const config = normalizeOptions(options);

  const fetchTimelinePageEffect = Effect.fn("FxTwitter.fetchTimelinePage")(function* (
    request: TimelineRequest,
  ): Effect.fn.Return<TimelineResponse, FxTwitterError> {
    const response = yield* requestRaw(config, timelineUrl(config.baseUrl, request), {
      allowNoContent: true,
      allowNotFound: false,
    });
    return yield* Effect.try({
      try: () => {
        if (response.bodyText === null) return { ...response, raw: null, page: null };
        const parsed = parseJson(response.bodyText);
        return { ...response, raw: parsed, page: parseTimelinePage(parsed) };
      },
      catch: decodeError,
    });
  });

  const fetchProfileEffect = Effect.fn("FxTwitter.fetchProfile")(function* (
    handle: string,
  ): Effect.fn.Return<ProfileResponse, FxTwitterError> {
    const response = yield* requestRaw(config, profileUrl(config.baseUrl, handle), {
      allowNoContent: false,
      allowNotFound: true,
    });
    return yield* Effect.try({
      try: () => {
        if (response.httpStatus === 404) {
          const raw = response.bodyText === null ? null : tryParseJson(response.bodyText);
          return { ...response, raw, profile: null };
        }
        const parsed = parseJson(response.bodyText ?? "");
        return { ...response, raw: parsed, profile: parseProfile(parsed) };
      },
      catch: decodeError,
    });
  });

  return {
    baseUrl: config.baseUrl,
    timelineUrl: (request) => timelineUrl(config.baseUrl, request),
    profileUrl: (handle) => profileUrl(config.baseUrl, handle),
    fetchTimelinePageEffect,
    fetchProfileEffect,
    fetchTimelinePage: (request) => Effect.runPromise(fetchTimelinePageEffect(request)),
    fetchProfile: (handle) => Effect.runPromise(fetchProfileEffect(handle)),
  };
}

/** @deprecated Prefer `makeFxTwitterClient`. Kept as a thin alias for call-site churn. */
export function FxTwitterClient(options: FxTwitterClientOptions = {}): PilotClient {
  return makeFxTwitterClient(options);
}

/** Wrap Promise-only fakes so acquisition can consume the Effect surface. */
export function pilotClientFromPromises(impl: {
  fetchProfile(handle: string): Promise<ProfileResponse>;
  fetchTimelinePage(request: TimelineRequest): Promise<TimelineResponse>;
  baseUrl?: string;
}): PilotClient {
  const baseUrl = (impl.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    baseUrl,
    timelineUrl: (request) => timelineUrl(baseUrl, request),
    profileUrl: (handle) => profileUrl(baseUrl, handle),
    fetchProfile: (handle) => impl.fetchProfile(handle),
    fetchTimelinePage: (request) => impl.fetchTimelinePage(request),
    fetchProfileEffect: Effect.fn("pilotClientFromPromises.fetchProfile")(function* (
      handle: string,
    ): Effect.fn.Return<ProfileResponse, FxTwitterError> {
      return yield* Effect.tryPromise({
        try: () => impl.fetchProfile(handle),
        catch: toFxTwitterError,
      });
    }),
    fetchTimelinePageEffect: Effect.fn("pilotClientFromPromises.fetchTimelinePage")(function* (
      request: TimelineRequest,
    ): Effect.fn.Return<TimelineResponse, FxTwitterError> {
      return yield* Effect.tryPromise({
        try: () => impl.fetchTimelinePage(request),
        catch: toFxTwitterError,
      });
    }),
  };
}

export function timelineUrl(baseUrl: string, request: TimelineRequest): string {
  const url = new URL(
    `${baseUrl.replace(/\/+$/, "")}/2/profile/${encodeURIComponent(request.handle)}/statuses`,
  );
  url.searchParams.set("count", String(request.count));
  if (request.cursor !== null) url.searchParams.set("cursor", request.cursor);
  if (request.withReplies) url.searchParams.set("with_replies", "true");
  return url.toString();
}

export function profileUrl(baseUrl: string, handle: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/2/profile/${encodeURIComponent(handle)}`;
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
    const envelope = Schema.decodeUnknownSync(FxTwitterProfileEnvelopeSchema)(value);
    const profile: FxTwitterProfile = {
      id: envelope.user.id,
      screenName: envelope.user.screen_name,
      name: envelope.user.name ?? "",
      protected: envelope.user.protected ?? false,
    };
    if (envelope.user.followers !== undefined) profile.followers = envelope.user.followers;
    if (envelope.user.statuses !== undefined) profile.statuses = envelope.user.statuses;
    return profile;
  } catch (cause) {
    throw decodeError(cause, "profile");
  }
}

function normalizeOptions(options: FxTwitterClientOptions): FxTwitterConfig {
  return {
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: options.timeoutMs ?? 15_000,
    retries: options.retries ?? 3,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep,
    now: options.now ?? Date.now,
  };
}

const requestRaw = Effect.fn("FxTwitter.requestRaw")(function* (
  config: FxTwitterConfig,
  url: string,
  options: { allowNoContent: boolean; allowNotFound: boolean },
): Effect.fn.Return<RawResponse, FxTwitterError> {
  // Mutable attempt state belongs to one execution, not to the reusable Effect.
  return yield* Effect.suspend(() => {
    const startedAt = performance.now();
    let attempt = 0;
    const once = Effect.tryPromise({
      try: async (signal): Promise<RawResponse> => {
        attempt += 1;
        const response = await config.fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": USER_AGENT },
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        });
        const receivedAt = config.now();

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
            kind: FxTwitterErrorKind.Http,
            retryDelay: retryDelayMs(response, attempt, config.retryBaseDelayMs),
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
      catch: (cause) =>
        cause instanceof FxTwitterError
          ? cause
          : new FxTwitterError({
              message: `FxTwitter request failed on attempt ${attempt}: ${errorMessage(cause)}`,
              status: null,
              responseBody: null,
              kind: FxTwitterErrorKind.Transport,
              retryDelay: exponentialDelayMs(attempt, config.retryBaseDelayMs),
            }),
    });
    return Effect.retry(once, {
      while: (error) => {
        const retryable =
          error.kind === FxTwitterErrorKind.Transport ||
          (error.kind === FxTwitterErrorKind.Http &&
            error.status !== null &&
            isRetryableStatus(error.status));
        if (!retryable || attempt > config.retries) return Effect.succeed(false);
        const sleep = config.sleep;
        if (sleep === undefined) return Effect.as(Effect.sleep(error.retryDelay), true);
        return Effect.as(
          Effect.tryPromise({
            try: () => sleep(error.retryDelay),
            catch: (cause) =>
              new FxTwitterError({
                message: `Retry wait failed: ${errorMessage(cause)}`,
                status: null,
                responseBody: null,
                kind: FxTwitterErrorKind.Transport,
                retryDelay: 0,
              }),
          }),
          true,
        );
      },
    });
  });
});

function toFxTwitterError(cause: unknown): FxTwitterError {
  return cause instanceof FxTwitterError
    ? cause
    : new FxTwitterError({
        message: errorMessage(cause),
        status: null,
        responseBody: null,
        kind: FxTwitterErrorKind.Transport,
        retryDelay: 0,
      });
}

function parseJson(body: string): FxTwitterJson {
  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(body));
  } catch {
    throw new FxTwitterError({
      message: "FxTwitter returned invalid JSON",
      status: 200,
      responseBody: body,
      kind: FxTwitterErrorKind.Decode,
      retryDelay: 0,
    });
  }
}

function tryParseJson(body: string): FxTwitterJson {
  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(body));
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
        kind: FxTwitterErrorKind.Decode,
        retryDelay: 0,
      });
}

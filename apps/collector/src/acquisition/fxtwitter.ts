// FxTwitter HTTP client (docs/COLLECTION.md §2). Owns retries, timeouts, and the
// documented response envelopes. It never interprets a response into ingress
// records; that is normalization's job (apps/collector/src/normalization).

const DEFAULT_BASE_URL = "https://api.fxtwitter.com";
const USER_AGENT = "xearch-collection-pilot/0.2";

export interface FxTwitterCursor {
  top: string | null;
  bottom: string | null;
}

export interface FxTwitterTimelinePage {
  code: number;
  results: unknown[];
  cursor: FxTwitterCursor;
}

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

export interface TimelineFetchResult {
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
  fetchTimelinePage(request: TimelineRequest): Promise<TimelineFetchResult>;
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

export class FxTwitterError extends Error {
  readonly status: number | null;
  readonly responseBody: string | null;

  constructor(
    message: string,
    status: number | null,
    responseBody: string | null,
  ) {
    super(message);
    this.name = "FxTwitterError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

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
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: FxTwitterClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
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

  async fetchTimelinePage(request: TimelineRequest): Promise<TimelineFetchResult> {
    const response = await this.request(this.timelineUrl(request), { allowNoContent: true, allowNotFound: false });
    if (response.bodyText === null) {
      return { ...response, raw: null, page: null };
    }
    const parsed = parseJson(response.bodyText);
    return { ...response, raw: parsed, page: parseTimelinePage(parsed) };
  }

  async fetchProfile(handle: string): Promise<ProfileResponse> {
    const response = await this.request(this.profileUrl(handle), { allowNoContent: false, allowNotFound: true });
    if (response.httpStatus === 404) {
      const raw = response.bodyText === null ? null : tryParseJson(response.bodyText);
      return { ...response, raw, profile: null };
    }
    const parsed = parseJson(response.bodyText ?? "");
    return { ...response, raw: parsed, profile: parseProfile(parsed) };
  }

  private async request(
    url: string,
    options: { allowNoContent: boolean; allowNotFound: boolean },
  ): Promise<RawResponse> {
    const startedAt = performance.now();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(this.timeoutMs),
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
          const error = new FxTwitterError(
            `FxTwitter returned HTTP ${response.status}`,
            response.status,
            bodyText,
          );
          if (isRetryableStatus(response.status) && attempt <= this.retries) {
            await this.sleep(retryDelayMs(response, attempt, this.retryBaseDelayMs));
            lastError = error;
            continue;
          }
          throw error;
        }
        return {
          httpStatus: response.status,
          latencyMs: performance.now() - startedAt,
          attempts: attempt,
          receivedAt,
          bodyText,
        };
      } catch (error) {
        if (error instanceof FxTwitterError) throw error;
        lastError = error;
        if (attempt > this.retries) break;
        await this.sleep(exponentialDelayMs(attempt, this.retryBaseDelayMs));
      }
    }

    throw new FxTwitterError(
      `FxTwitter request failed after ${this.retries + 1} attempts: ${errorMessage(lastError)}`,
      null,
      null,
    );
  }
}

export function parseTimelinePage(value: unknown): FxTwitterTimelinePage {
  if (!isRecord(value)) {
    throw new FxTwitterError("FxTwitter timeline response is not an object", 200, null);
  }
  if (
    typeof value.code !== "number" ||
    !Number.isFinite(value.code) ||
    !Array.isArray(value.results) ||
    !isRecord(value.cursor) ||
    !isNullableString(value.cursor.top) ||
    !isNullableString(value.cursor.bottom)
  ) {
    throw new FxTwitterError(
      "FxTwitter timeline response does not match the documented envelope",
      200,
      JSON.stringify(value),
    );
  }

  return {
    code: value.code,
    results: value.results,
    cursor: {
      top: value.cursor.top ?? null,
      bottom: value.cursor.bottom ?? null,
    },
  };
}

export function parseProfile(value: unknown): FxTwitterProfile {
  if (!isRecord(value) || !isRecord(value.user)) {
    throw new FxTwitterError("FxTwitter profile response does not contain a user", 200, JSON.stringify(value));
  }
  const user = value.user;
  if (typeof user.id !== "string" || user.id.length === 0 || typeof user.screen_name !== "string") {
    throw new FxTwitterError("FxTwitter profile user lacks id or screen_name", 200, JSON.stringify(value));
  }
  return {
    id: user.id,
    screenName: user.screen_name,
    name: typeof user.name === "string" ? user.name : "",
    protected: user.protected === true,
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FxTwitterError("FxTwitter returned invalid JSON", 200, body);
  }
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
